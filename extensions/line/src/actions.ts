import type { messagingApi } from "@line/bot-sdk";

export type Action = messagingApi.Action;

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return {
    label: label.slice(0, 20),
    text: text ?? label,
    type: "message",
  };
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return {
    label: label.slice(0, 20),
    type: "uri",
    uri,
  };
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return {
    data: data.slice(0, 300),
    displayText: displayText?.slice(0, 300),
    label: label.slice(0, 20),
    type: "postback",
  };
}

/**
 * Create a datetime picker action
 */
export function datetimePickerAction(
  label: string,
  data: string,
  mode: "date" | "time" | "datetime",
  options?: {
    initial?: string;
    max?: string;
    min?: string;
  },
): Action {
  return {
    data: data.slice(0, 300),
    initial: options?.initial,
    label: label.slice(0, 20),
    max: options?.max,
    min: options?.min,
    mode,
    type: "datetimepicker",
  };
}
