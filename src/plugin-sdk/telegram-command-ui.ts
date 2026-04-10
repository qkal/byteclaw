export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): { text: string; callback_data: string }[][] {
  const buttons: { text: string; callback_data: string }[] = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
      text: "◀ Prev",
    });
  }

  buttons.push({
    callback_data: `commands_page_noop${suffix}`,
    text: `${currentPage}/${totalPages}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
      text: "Next ▶",
    });
  }

  return [buttons];
}
