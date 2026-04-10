export const ThreadType = {
  Group: 1,
  User: 0,
} as const;

export const LoginQRCallbackEventType = {
  GotLoginInfo: 4,
  QRCodeDeclined: 3,
  QRCodeExpired: 1,
  QRCodeGenerated: 0,
  QRCodeScanned: 2,
} as const;

export const Reactions = {
  ANGRY: ":-h",
  CRY: ":-((",
  HAHA: ":>",
  HEART: "/-heart",
  LIKE: "/-strong",
  NONE: "",
  WOW: ":o",
} as const;

// Mirror zca-js sendMessage style constants locally because the package root
// Typing surface does not consistently expose TextStyle/Style to tsgo.
export const TextStyle = {
  Big: "f_18",
  Bold: "b",
  Green: "c_15a85f",
  Indent: "ind_$",
  Italic: "i",
  Orange: "c_f27806",
  OrderedList: "lst_2",
  Red: "c_db342e",
  Small: "f_13",
  StrikeThrough: "s",
  Underline: "u",
  UnorderedList: "lst_1",
  Yellow: "c_f7b503",
} as const;

type TextStyleValue = (typeof TextStyle)[keyof typeof TextStyle];

export type Style =
  | {
      start: number;
      len: number;
      st: Exclude<TextStyleValue, typeof TextStyle.Indent>;
    }
  | {
      start: number;
      len: number;
      st: typeof TextStyle.Indent;
      indentSize?: number;
    };
