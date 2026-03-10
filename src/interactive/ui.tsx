import React, {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ParsedOptions } from "../cli/parse.js";
import type { RuntimeDoctor, RuntimeEnvironment } from "../runtime/api.js";
import { approveTask, listSessions, resumeTask, startTask } from "../runtime/api.js";
import type { SessionRecord } from "../session/store.js";
import {
  appendInteractiveInput,
  applyCommandResultToModel,
  applyRuntimeEventToModel,
  beginPromptRun,
  buildViewportLines,
  createInteractiveModel,
  enqueuePrompt,
  nextQueuedPrompt,
  refreshRecentSessions,
  scrollInteractiveViewport,
  setInteractiveInput,
  toggleApprovalChoice,
  trimInteractiveInput,
  type InteractiveModel,
  type TranscriptBlock
} from "./model.js";

interface InteractiveExit {
  code: number;
  sessionId: string | null;
  status: InteractiveModel["runtimeStatus"];
}

export function InteractiveApp(props: {
  doctor: RuntimeDoctor | null;
  onExit: (payload: InteractiveExit) => void;
  options: ParsedOptions;
  recentSessions: SessionRecord[];
  runtime?: RuntimeEnvironment;
}): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [model, setModel] = useState(() =>
    createInteractiveModel({
      cwd: props.runtime?.processCwd ?? process.cwd(),
      doctor: props.doctor,
      recentSessions: props.recentSessions
    })
  );
  const runActiveRef = useRef(false);
  const modelRef = useRef(model);
  const [revealedAssistantChars, setRevealedAssistantChars] = useState<Record<string, number>>({});

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    const latestAssistant = [...model.blocks].reverse().find((block) => block.kind === "assistant");

    if (!latestAssistant) {
      return;
    }

    const targetLength = latestAssistant.lines.join("\n").length;
    if (!(latestAssistant.id in revealedAssistantChars)) {
      setRevealedAssistantChars((current) => ({
        ...current,
        [latestAssistant.id]: 0
      }));
      return;
    }

    const currentLength = revealedAssistantChars[latestAssistant.id] ?? 0;

    if (currentLength >= targetLength) {
      return;
    }

    const timer = setInterval(() => {
      setRevealedAssistantChars((current) => {
        const nextLength = Math.min(targetLength, (current[latestAssistant.id] ?? 0) + 48);
        return {
          ...current,
          [latestAssistant.id]: nextLength
        };
      });
    }, 16);

    return () => {
      clearInterval(timer);
    };
  }, [model.blocks, revealedAssistantChars]);

  const updateModel = useEffectEvent((updater: (current: InteractiveModel) => InteractiveModel) => {
    startTransition(() => {
      setModel((current) => {
        const next = updater(current);
        modelRef.current = next;
        return next;
      });
    });
  });

  const refreshSessions = useEffectEvent(async () => {
    const recent = await listSessions({
      ...(props.runtime ? { environment: props.runtime } : {}),
      limit: 5
    }).catch(() => modelRef.current.recentSessions);

    updateModel((current) => refreshRecentSessions(current, recent));
  });

  const maybeStartNextQueuedPrompt = useEffectEvent(() => {
    if (runActiveRef.current || modelRef.current.pendingApproval) {
      return;
    }

    const next = nextQueuedPrompt(modelRef.current);
    if (!next) {
      return;
    }

    void runPrompt(next.id, next.prompt);
  });

  const handleRunResult = useEffectEvent(async (result: Awaited<ReturnType<typeof startTask>> | Awaited<ReturnType<typeof resumeTask>>) => {
    if (!result) {
      updateModel((current) => ({
        ...current,
        blocks: [
          ...current.blocks,
          {
            id: `system:${Date.now()}`,
            kind: "system",
            lines: ["Session not found."],
            tone: "warning"
          }
        ]
      }));
      return;
    }

    updateModel((current) => applyCommandResultToModel(current, result));
    await refreshSessions();
  });

  const runPrompt = useEffectEvent(async (promptId: string, prompt: string) => {
    if (runActiveRef.current) {
      return;
    }

    runActiveRef.current = true;
    updateModel((current) => beginPromptRun(current, promptId));
    const observer = {
      onEvent(event: import("../cli/output.js").RuntimeEvent) {
        updateModel((current) => applyRuntimeEventToModel(current, event));
      }
    };

    try {
      const result = await startTask({
        ...(props.runtime ? { environment: props.runtime } : {}),
        observer,
        options: props.options,
        prompt
      });
      await handleRunResult(result);
    } finally {
      runActiveRef.current = false;
      maybeStartNextQueuedPrompt();
    }
  });

  const runResumeLatest = useEffectEvent(async () => {
    if (runActiveRef.current) {
      return;
    }

    const session = modelRef.current.recentSessions[0];
    if (!session) {
      return;
    }

    runActiveRef.current = true;
    updateModel((current) => ({
      ...current,
      runtimeStatus: "resuming",
      scrollOffset: 0
    }));
    const observer = {
      onEvent(event: import("../cli/output.js").RuntimeEvent) {
        updateModel((current) => applyRuntimeEventToModel(current, event));
      }
    };

    try {
      const result = await resumeTask({
        ...(props.runtime ? { environment: props.runtime } : {}),
        observer,
        options: props.options,
        sessionId: session.id
      });
      await handleRunResult(result);
    } finally {
      runActiveRef.current = false;
      maybeStartNextQueuedPrompt();
    }
  });

  const resolveApproval = useEffectEvent(async () => {
    if (runActiveRef.current || !modelRef.current.pendingApproval || !modelRef.current.sessionId) {
      return;
    }

    runActiveRef.current = true;
    const decision = modelRef.current.approvalChoiceIndex === 0 ? "approve" : "reject";
    updateModel((current) => ({
      ...current,
      runtimeStatus: "resuming",
      scrollOffset: 0
    }));

    const observer = {
      onEvent(event: import("../cli/output.js").RuntimeEvent) {
        updateModel((current) => applyRuntimeEventToModel(current, event));
      }
    };

    try {
      const result = await approveTask({
        decision,
        ...(props.runtime ? { environment: props.runtime } : {}),
        observer,
        options: props.options,
        sessionId: modelRef.current.sessionId
      });
      await handleRunResult(result);
    } finally {
      runActiveRef.current = false;
      maybeStartNextQueuedPrompt();
    }
  });

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const payload = {
        code: 0,
        sessionId: modelRef.current.sessionId,
        status: modelRef.current.runtimeStatus
      };
      props.onExit(payload);
      exit(payload);
      return;
    }

    if (key.upArrow) {
      if (modelRef.current.pendingApproval && modelRef.current.input.length === 0) {
        updateModel((current) => toggleApprovalChoice(current));
      } else {
        updateModel((current) => scrollInteractiveViewport(current, "up"));
      }
      return;
    }

    if (key.downArrow) {
      if (modelRef.current.pendingApproval && modelRef.current.input.length === 0) {
        updateModel((current) => toggleApprovalChoice(current));
      } else {
        updateModel((current) => scrollInteractiveViewport(current, "down"));
      }
      return;
    }

    if (key.pageUp) {
      updateModel((current) => scrollInteractiveViewport(current, "page_up"));
      return;
    }

    if (key.pageDown) {
      updateModel((current) => scrollInteractiveViewport(current, "page_down"));
      return;
    }

    if (key.end) {
      updateModel((current) => scrollInteractiveViewport(current, "end"));
      return;
    }

    if (key.escape) {
      updateModel((current) => setInteractiveInput(current, ""));
      return;
    }

    if (key.backspace || key.delete) {
      updateModel((current) => trimInteractiveInput(current));
      return;
    }

    if (key.return) {
      const prompt = modelRef.current.input.trim();
      if (prompt.length > 0) {
        const queued = enqueuePrompt(modelRef.current, prompt);
        updateModel(() => queued.state);
        if (!runActiveRef.current && queued.state.pendingApproval === null) {
          void runPrompt(queued.promptId, prompt);
        }
        return;
      }

      if (modelRef.current.pendingApproval) {
        void resolveApproval();
        return;
      }

      if (!runActiveRef.current && modelRef.current.recentSessions.length > 0) {
        void runResumeLatest();
      }
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      updateModel((current) => appendInteractiveInput(current, input));
    }
  });

  const lines = useMemo(() => {
    const rows = Math.max(12, stdout.rows ?? 24);
    const columns = Math.max(60, stdout.columns ?? 80);
    return buildViewportLines({
      columns,
      model: applyAssistantReveal(model, revealedAssistantChars),
      rows
    });
  }, [model, revealedAssistantChars, stdout.columns, stdout.rows]);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text
          key={index}
          {...(line.backgroundColor ? { backgroundColor: line.backgroundColor } : {})}
          {...(line.bold ? { bold: true } : {})}
          {...(line.color ? { color: line.color } : {})}
          {...(line.dimColor ? { dimColor: true } : {})}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

function applyAssistantReveal(
  model: InteractiveModel,
  revealedAssistantChars: Record<string, number>
): InteractiveModel {
  return {
    ...model,
    blocks: model.blocks.map((block) => {
      if (block.kind !== "assistant") {
        return block;
      }

      const fullText = block.lines.join("\n");
      const visibleChars = revealedAssistantChars[block.id] ?? fullText.length;

      return {
        ...block,
        lines: fullText.slice(0, visibleChars).split("\n")
      } satisfies TranscriptBlock;
    })
  };
}
