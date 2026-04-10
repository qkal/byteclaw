import { formatErrorMessage } from "../infra/errors.js";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

export interface FinalizableDraftStreamState {
  stopped: boolean;
  final: boolean;
}

interface StopAndClearMessageIdParams<T> {
  stopForClear: () => Promise<void>;
  readMessageId: () => T | undefined;
  clearMessageId: () => void;
}

type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
  isValidMessageId: (value: unknown) => value is T;
  deleteMessage: (messageId: T) => Promise<void>;
  onDeleteSuccess?: (messageId: T) => void;
  warn?: (message: string) => void;
  warnPrefix: string;
};

type FinalizableDraftLifecycleParams<T> = Omit<
  ClearFinalizableDraftMessageParams<T>,
  "stopForClear"
> & {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
};

export function createFinalizableDraftStreamControls(params: {
  throttleMs: number;
  isStopped: () => boolean;
  isFinal: () => boolean;
  markStopped: () => void;
  markFinal: () => void;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  const loop = createDraftStreamLoop({
    isStopped: params.isStopped,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    throttleMs: params.throttleMs,
  });

  const update = (text: string) => {
    if (params.isStopped() || params.isFinal()) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    params.markFinal();
    await loop.flush();
  };

  const stopForClear = async (): Promise<void> => {
    params.markStopped();
    loop.stop();
    await loop.waitForInFlight();
  };

  return {
    loop,
    stop,
    stopForClear,
    update,
  };
}

export function createFinalizableDraftStreamControlsForState(params: {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  return createFinalizableDraftStreamControls({
    isFinal: () => params.state.final,
    isStopped: () => params.state.stopped,
    markFinal: () => {
      params.state.final = true;
    },
    markStopped: () => {
      params.state.stopped = true;
    },
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    throttleMs: params.throttleMs,
  });
}

export async function takeMessageIdAfterStop<T>(
  params: StopAndClearMessageIdParams<T>,
): Promise<T | undefined> {
  await params.stopForClear();
  const messageId = params.readMessageId();
  params.clearMessageId();
  return messageId;
}

export async function clearFinalizableDraftMessage<T>(
  params: ClearFinalizableDraftMessageParams<T>,
): Promise<void> {
  const messageId = await takeMessageIdAfterStop({
    clearMessageId: params.clearMessageId,
    readMessageId: params.readMessageId,
    stopForClear: params.stopForClear,
  });
  if (!params.isValidMessageId(messageId)) {
    return;
  }
  try {
    await params.deleteMessage(messageId);
    params.onDeleteSuccess?.(messageId);
  } catch (error) {
    params.warn?.(`${params.warnPrefix}: ${formatErrorMessage(error)}`);
  }
}

export function createFinalizableDraftLifecycle<T>(params: FinalizableDraftLifecycleParams<T>) {
  const controls = createFinalizableDraftStreamControlsForState({
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    state: params.state,
    throttleMs: params.throttleMs,
  });

  const clear = async () => {
    await clearFinalizableDraftMessage({
      clearMessageId: params.clearMessageId,
      deleteMessage: params.deleteMessage,
      isValidMessageId: params.isValidMessageId,
      onDeleteSuccess: params.onDeleteSuccess,
      readMessageId: params.readMessageId,
      stopForClear: controls.stopForClear,
      warn: params.warn,
      warnPrefix: params.warnPrefix,
    });
  };

  return {
    ...controls,
    clear,
  };
}
