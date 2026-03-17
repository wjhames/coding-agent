import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { trackHarnessChild } from "./cli-harness.js";

export function spawnInteractiveCli(input: {
  cwd: string;
  distCli: string;
  homeDir: string;
  repoRoot: string;
}): {
  child: ChildProcess;
  getOutput: () => string;
  stdin: NodeJS.WritableStream;
} {
  const child = spawn(
    "python3",
    [
      "-u",
      "-c",
      [
        "import os, pty, select, subprocess, sys",
        "cmd = sys.argv[1:]",
        "master, slave = pty.openpty()",
        "proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=os.environ.copy())",
        "os.close(slave)",
        "while True:",
        "    readers = [master, sys.stdin.fileno()]",
        "    ready, _, _ = select.select(readers, [], [], 0.05)",
        "    if master in ready:",
        "        try:",
        "            data = os.read(master, 4096)",
        "        except OSError:",
        "            data = b''",
        "        if data:",
        "            os.write(sys.stdout.fileno(), data)",
        "            sys.stdout.flush()",
        "        elif proc.poll() is not None:",
        "            break",
        "    if sys.stdin.fileno() in ready:",
        "        incoming = os.read(sys.stdin.fileno(), 4096)",
        "        if incoming:",
        "            os.write(master, incoming)",
        "    if proc.poll() is not None and not ready:",
        "        break",
        "if proc.poll() is None:",
        "    proc.terminate()",
        "sys.exit(proc.wait())"
      ].join("\n"),
      process.execPath,
      input.distCli,
      "--cwd",
      input.cwd
    ],
    {
      cwd: input.repoRoot,
      env: {
        ...process.env,
        CODING_AGENT_HOME: join(input.homeDir, ".coding-agent"),
        FORCE_COLOR: "0"
      }
    }
  );
  trackHarnessChild(child);

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  return {
    child,
    getOutput: () => stripTerminalNoise(output),
    stdin: child.stdin
  };
}

export async function waitForOutput(
  session: { getOutput: () => string },
  text: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.getOutput().includes(text)) {
      return;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for output: ${text}\n\nCurrent output:\n${session.getOutput()}`);
}

export async function outputAppearsWithin(
  session: { getOutput: () => string },
  text: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.getOutput().includes(text)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const close = once(child, "close").then(() => undefined);
  const timeout = sleep(timeoutMs).then(() => {
    throw new Error("Timed out waiting for process exit.");
  });
  await Promise.race([close, timeout]);
}

export async function typeText(stream: NodeJS.WritableStream, text: string): Promise<void> {
  for (const character of text) {
    stream.write(character);
    await sleep(10);
  }
}

function stripTerminalNoise(value: string): string {
  return value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "")
    .replace(/\r/g, "")
    .replace(/\u0007/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
