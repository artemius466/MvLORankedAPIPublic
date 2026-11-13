// MvLO Ranked — Markdown & Unity Rich Text renderer for frontend.
"use strict";
(function () {
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function render(rawText) {
    if (!rawText || typeof rawText !== "string") return "";

    let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // 1. Extract and preserve code blocks
    const codeBlocks = [];
    text = text.replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(esc(code.trim()));
      return `\x01CB_${codeBlocks.length - 1}\x02`;
    });

    // 2. Extract and preserve inline code
    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(esc(code));
      return `\x01IC_${inlineCodes.length - 1}\x02`;
    });

    // 3. Stash allowed Unity / HTML tags before escaping
    const allowedTags = [];
    text = text.replace(/<\/?(?:b|i|u|s|size(?:=\d+)?|color(?:=[#a-zA-Z0-9]+)?)>/gi, (tag) => {
      allowedTags.push(tag);
      return `\x01TAG_${allowedTags.length - 1}\x02`;
    });

    // 4. Escape remaining HTML to prevent XSS
    text = esc(text);

    // 5. Restore allowed Unity/HTML tags and convert to valid styled HTML
    text = text.replace(/\x01TAG_(\d+)\x02/g, (_, idx) => {
      const tag = allowedTags[Number(idx)] || "";
      const lower = tag.toLowerCase();

      if (lower.startsWith("<size=")) {
        const size = lower.match(/\d+/);
        return size ? `<span style="font-size:${size[0]}px;line-height:1.25">` : "<span>";
      }
      if (lower === "</size>") return "</span>";

      if (lower.startsWith("<color=")) {
        const color = tag.substring(7, tag.length - 1);
        return `<span style="color:${esc(color)}">`;
      }
      if (lower === "</color>") return "</span>";

      if (lower === "<b>" || lower === "</b>") return lower;
      if (lower === "<i>" || lower === "</i>") return lower;
      if (lower === "<u>" || lower === "</u>") return lower;
      if (lower === "<s>" || lower === "</s>") return lower;

      return "";
    });

    // 6. Markdown Headings
    text = text.replace(/^#### (.*)$/gm, '<h5 style="margin:8px 0 3px;font:16px \'MarioUI\';color:#17161d;letter-spacing:1px">$1</h5>');
    text = text.replace(/^### (.*)$/gm, '<h4 style="margin:10px 0 4px;font:18px \'MarioUI\';color:#17161d;letter-spacing:1px">$1</h4>');
    text = text.replace(/^## (.*)$/gm, '<h3 style="margin:14px 0 6px;font:22px \'MarioUI\';color:#17161d;letter-spacing:1px">$1</h3>');
    text = text.replace(/^# (.*)$/gm, '<h2 style="margin:16px 0 8px;font:26px \'MarioUI\';color:#17161d;letter-spacing:1px">$1</h2>');

    // 7. Horizontal rules
    text = text.replace(/^(?:---|___|\*\*\*)\s*$/gm, '<hr style="border:none;border-top:3px dashed #17161d;margin:14px 0">');

    // 8. Blockquotes
    text = text.replace(/^>\s*(.*)$/gm, '<blockquote style="margin:8px 0;padding:6px 12px;border-left:4px solid #3a7bd8;background:#e8f0fe;color:#17161d;font-style:italic">$1</blockquote>');

    // 9. Bold & Italic markdown
    text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 10. Links: [label](url) - only allow http/https or relative paths
    text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (match, label, url) => {
      const safeUrl = esc(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#1b4fd8;text-decoration:underline">${label}</a>`;
    });

    // 11. Bullet Lists: Convert consecutive lines with - or * into <ul><li>...</li></ul>
    text = text.replace(/(?:^|\n)(?:[-*]\s+.*(?:\n|$))+/g, (listBlock) => {
      const items = listBlock
        .trim()
        .split('\n')
        .map((line) => line.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
        .map((item) => `<li style="margin:3px 0">${item}</li>`)
        .join('');
      return `\n<ul style="margin:8px 0 8px 24px;padding:0;list-style-type:square">${items}</ul>\n`;
    });

    // 12. Restore code blocks
    text = text.replace(/\x01CB_(\d+)\x02/g, (_, idx) => {
      const code = codeBlocks[Number(idx)] || '';
      return `<pre style="background:#17161d;color:#fdf3d7;padding:12px;border:3px solid #17161d;overflow-x:auto;font-family:ui-monospace,monospace;font-size:14px;line-height:1.4"><code>${code}</code></pre>`;
    });

    // 13. Restore inline code
    text = text.replace(/\x01IC_(\d+)\x02/g, (_, idx) => {
      const code = inlineCodes[Number(idx)] || '';
      return `<code style="background:#ffe9a8;color:#5b4408;padding:2px 6px;border:2px solid #17161d;font-family:ui-monospace,monospace;font-size:14px">${code}</code>`;
    });

    // 14. Convert paragraphs and line breaks
    // Split by two or more newlines
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        // If it starts with block element, don't wrap in <p>
        if (/^<(h[2-6]|hr|blockquote|pre|ul)/i.test(p)) {
          return p.replace(/\n/g, "<br>");
        }
        return `<p style="margin:0 0 10px;font:16px/1.6 'MarioUI';color:#4c4634">${p.replace(/\n/g, "<br>")}</p>`;
      });

    return paragraphs.join("\n");
  }

  window.MvLOMarkdown = { render };
})();
