export const shortenText = (value: string, maxLen: number) => {
  const chars = [...value];
  if (chars.length <= maxLen) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};
