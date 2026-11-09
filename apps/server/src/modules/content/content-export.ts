import type { ContentItem, ContentVersion, ExportContentInput } from '@creator-ai/contracts';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const escapeMarkdown = (s: string) => escapeHtml(s).replace(/([\\`*_{}\[\]()#+.!|>~\-])/g, '\\$1');

export function renderContentExport(
  item: ContentItem,
  version: ContentVersion,
  format: ExportContentInput['format'],
  approved: boolean,
) {
  const warnings = [
    ...(item.isMock ? ['模拟内容，不是真实模型生成，不能用于正式发布。'] : []),
    ...(!approved ? ['此版本未获得当前有效审核通过，仅供人工核对。'] : []),
    '仅导出文件，不代表已发布；事实、版权和平台规则仍需人工核实。',
  ];
  const meta = `Creator-AI | v${version.version} | source ${item.sourceRunId}`;
  const blocks = version.document.content;
  let body: string;
  let mime: string;
  if (format === 'json') {
    mime = 'application/json';
    body = JSON.stringify(
      {
        schemaVersion: 1,
        sourceRunId: item.sourceRunId,
        contentId: item.id,
        version: version.version,
        isMock: item.isMock,
        approved,
        warnings,
        title: version.title,
        document: version.document,
      },
      null,
      2,
    );
  } else if (format === 'md') {
    mime = 'text/markdown';
    body =
      [
        `# ${escapeMarkdown(version.title)}`,
        ...warnings.map((w) => `> ${w}`),
        meta,
        ...blocks.map(
          (b) =>
            `${b.type === 'heading' ? '#'.repeat(b.attrs.level) + ' ' : ''}${escapeMarkdown(b.content.map((t) => t.text).join('')).replace(/\r?\n/g, '  \n')}`,
        ),
      ].join('\n\n') + '\n';
  } else {
    mime = 'text/html';
    const content = blocks
      .map((b) => {
        const tag = b.type === 'heading' ? `h${b.attrs.level}` : 'p';
        return `<${tag}>${escapeHtml(b.content.map((t) => t.text).join(''))}</${tag}>`;
      })
      .join('\n');
    body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(version.title)}</title><style>body{max-width:760px;margin:40px auto;padding:24px;font:18px/1.9 Georgia,serif;color:#243b30;background:#faf8f2}p,h2,h3{white-space:pre-wrap;overflow-wrap:anywhere}aside{border:1px solid #aa7b3a;padding:16px;font-size:14px}footer{font-size:12px;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(version.title)}</h1><aside>${warnings.map(escapeHtml).join('<br>')}</aside>${content}<footer>${escapeHtml(meta)}</footer></body></html>`;
  }
  return { body, mime, filename: `content-${item.id}-v${version.version}.${format}` };
}
