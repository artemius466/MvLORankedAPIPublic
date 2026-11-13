/**
 * Translates Markdown to Unity Rich Text format.
 * Compatible with Unity UI (Text) and TextMeshPro.
 */
function markdownToUnityRichText(md) {
  if (typeof md !== 'string') return '';

  // Normalize line endings to \n for uniform processing
  let text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Stash code blocks so their contents aren't parsed as markdown
  const codeBlocks = [];
  text = text.replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.trim());
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Stash inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `__INLINE_CODE_${inlineCodes.length - 1}__`;
  });

  // Headings
  text = text.replace(/^#### (.*)$/gm, '<size=15>$1</size>');
  text = text.replace(/^### (.*)$/gm, '<size=16>$1</size>');
  text = text.replace(/^## (.*)$/gm, '<size=18>$1</size>');
  text = text.replace(/^# (.*)$/gm, '<size=20>$1</size>');

  // Horizontal rules
  text = text.replace(/^(?:---|___|\*\*\*)\s*$/gm, '――――――――――――――――――――');

  // Blockquotes
  text = text.replace(/^>\s*(.*)$/gm, '<i>"$1"</i>');

  // Bold & Italic (*** or ___) - bold ignored, only italic applied
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<i>$1</i>');
  text = text.replace(/(?<![a-zA-Z0-9])___([^_ \n][^_\n]*[^_ \n])___(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Bold (** or __) is ignored completely

  // Italic (* or _)
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<![a-zA-Z0-9])_([^_ \n][^_\n]*[^_ \n])_(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Strikethrough (~~)
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // Links: [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    if (label.trim() === url.trim()) {
      return `<color=#5c94fc><u>${label}</u></color>`;
    }
    return `<color=#5c94fc><u>${label}</u></color> (${url})`;
  });

  // Restore inline code
  text = text.replace(/__INLINE_CODE_(\d+)__/g, (_, idx) => {
    const code = inlineCodes[Number(idx)] || '';
    return `<color=#ffe9a8>${code}</color>`;
  });

  // Restore code blocks
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => {
    const code = codeBlocks[Number(idx)] || '';
    return `\n${code}\n`;
  });

  // Unity uses \r\n line breaks
  return text.replace(/\n/g, '\r\n');
}

module.exports = { markdownToUnityRichText };
