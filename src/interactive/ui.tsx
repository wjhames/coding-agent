import React, { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ParsedOptions } from "../cli/parse.js";
import type { RuntimeEvent } from "../runtime/contracts.js";
import type { RuntimeDoctor, RuntimeEnvironment } from "../runtime/api.js";
import { approveTask, continueTask, listSessions, resumeTask, startTask } from "../runtime/api.js";
import type { SessionRecord } from "../session/store.js";
import {
  appendInteractiveInput,
  beginPromptRun,
  createInteractiveModel,
  enqueuePrompt,
  insertInteractiveLineBreak,
  nextQueuedPrompt,
  refreshRecentSessions,
  scrollInteractiveViewport,
  setInteractiveInput,
  toggleApprovalChoice,
  trimInteractiveInput,
  type InteractiveModel
} from "./state.js";
import { applyCommandResultToModel, applyRuntimeEventToModel } from "./reducer.js";
import { buildViewportLines, reconcileViewportScroll } from "./render.js";

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

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const updateModel = useEffectEvent((updater: (current: InteractiveModel) => InteractiveModel) => {
    startTransition(() => {
      setModel((current) => {
        const next = reconcileViewportScroll(
          current,
          updater(current),
          Math.max(60, stdout.columns ?? 80)
        );
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
      onEvent(event: RuntimeEvent) {
        updateModel((current) => applyRuntimeEventToModel(current, event));
      }
    };

    try {
      const currentSessionId = modelRef.current.sessionId;
      const result =
        currentSessionId && !modelRef.current.pendingApproval
          ? await continueTask({
              ...(props.runtime ? { environment: props.runtime } : {}),
              observer,
              options: props.options,
              prompt,
              sessionId: currentSessionId
            })
          : await startTask({
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
      onEvent(event: RuntimeEvent) {
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
      onEvent(event: RuntimeEvent) {
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

    if (key.home) {
      updateModel((current) => scrollInteractiveViewport(current, "top"));
      return;
    }

    if (key.end) {
      updateModel((current) => scrollInteractiveViewport(current, "end"));
      return;
    }

    if (key.ctrl && input === "l") {
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

    if ((key.ctrl && input === "j") || (key.return && (key.shift || key.meta))) {
      updateModel((current) => insertInteractiveLineBreak(current));
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
      model,
      rows
    });
  }, [model, stdout.columns, stdout.rows]);

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
          {line.segments
            ? line.segments.map((segment, segmentIndex) => (
                <Text
                  key={`${index}:${segmentIndex}`}
                  {...(segment.backgroundColor ? { backgroundColor: segment.backgroundColor } : {})}
                  {...(segment.bold ? { bold: true } : {})}
                  {...(segment.color ? { color: segment.color } : {})}
                  {...(segment.dimColor ? { dimColor: true } : {})}
                >
                  {segment.text}
                </Text>
              ))
            : line.text}
        </Text>
      ))}
    </Box>
  );
}
