import { vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  sendDeliveredZalouserMock: vi.fn(async () => {}),
  sendMessageZalouserMock: vi.fn(async () => {}),
  sendSeenZalouserMock: vi.fn(async () => {}),
  sendTypingZalouserMock: vi.fn(async () => {}),
}));

export const {sendMessageZalouserMock} = sendMocks;
export const {sendTypingZalouserMock} = sendMocks;
export const {sendDeliveredZalouserMock} = sendMocks;
export const {sendSeenZalouserMock} = sendMocks;

vi.mock("./send.js", () => ({
  sendDeliveredZalouser: sendDeliveredZalouserMock,
  sendMessageZalouser: sendMessageZalouserMock,
  sendSeenZalouser: sendSeenZalouserMock,
  sendTypingZalouser: sendTypingZalouserMock,
}));
