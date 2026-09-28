/* ============================================================
   markdown.js —— 轻量 Markdown 渲染器（零依赖）
   支持：标题 / 段落 / 有序无序列表（含嵌套）/ 表格 / 引用 /
         代码块 / 行内代码 / 粗体 / 斜体 / 删除线 / 链接 / 分割线
   ============================================================ */
(function (global) {
  'use strict';

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------- 行内解析 */
  function renderInline(text) {
    var codes = [];
    var out = escapeHtml(text);

    // 换行 -> <br />
    out = out.replace(/\n/g, '<br />');

    // 先保护行内代码，避免其中的 * _ 被当成强调
    out = out.replace(/`([^`]+)`/g, function (m, code) {
      codes.push(code);
      return '\u0001' + (codes.length - 1) + '\u0001';
    });

    // 图片 ![alt](url)
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<img src="$2" alt="$1" style="max-width:100%;border-radius:10px" />');

    // 链接 [text](url)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 裸链接
    out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<)）+]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    // 粗体（先于斜体）
    out = out.replace(/\*\*([^\s*][^*]*?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^\s_][^_]*?)__/g, '<strong>$1</strong>');

    // 斜体
    out = out.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^\s_][^_\n]*?)_(?![\w_])/g, '$1<em>$2</em>');

    // 删除线
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 还原行内代码
    out = out.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return '<code>' + codes[Number(i)] + '</code>';
    });

    return out;
  }

  /* ---------------------------------------------- 工具 */
  function splitRow(line) {
    var s = String(line).trim();
    s = s.replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function isTableSeparator(line) {
    if (line.indexOf('-') === -1) return false;
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
  }

  var RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_UL = /^(\s*)[-*+]\s+(.*)$/;
  var RE_OL = /^(\s*)\d+[.)]\s+(.*)$/;
  var RE_QUOTE = /^\s{0,3}>\s?/;
  var RE_BLOCK_START = /^\s*(#{1,6}\s|>|\||\u0000BLOCK)/;

  /* ---------------------------------------------- 块级解析 */
  function render(src) {
    if (src === null || src === undefined) return '';
    var text = String(src).replace(/\r\n?/g, '\n');

    // 1. 抽出围栏代码块
    var codeBlocks = [];
    text = text.replace(/```[ \t]*([\w+#.-]*)[ \t]*\n([\s\S]*?)```/g, function (m, lang, code) {
      codeBlocks.push(
        '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
        escapeHtml(code.replace(/\n+$/, '')) + '</code></pre>'
      );
      return '\n\u0000BLOCK' + (codeBlocks.length - 1) + '\u0000\n';
    });

    var lines = text.split('\n');
    var out = [];
    var stack = [];   // 打开的列表：[{ type, indent }]
    var i = 0;

    function closeLists(toIndent) {
      while (stack.length) {
        var top = stack[stack.length - 1];
        if (toIndent >= 0 && top.indent <= toIndent) break;
        stack.pop();
        out.push('</li></' + top.type + '>');
      }
    }

    function openList(type, indent) {
      stack.push({ type: type, indent: indent });
      out.push('<' + type + '><li>');
    }

    function indentOf(spaces) {
      return spaces.replace(/\t/g, '    ').length;
    }

    while (i < lines.length) {
      var line = lines[i];

      // 代码块占位
      var ph = line.match(/^\u0000BLOCK(\d+)\u0000$/);
      if (ph) {
        closeLists(-1);
        out.push(codeBlocks[Number(ph[1])]);
        i++;
        continue;
      }

      // 空行
      if (!line.trim()) {
        closeLists(-1);
        i++;
        continue;
      }

      // 分割线
      if (RE_HR.test(line)) {
        closeLists(-1);
        out.push('<hr />');
        i++;
        continue;
      }

      // 标题
      var h = line.match(RE_HEADING);
      if (h) {
        closeLists(-1);
        var lv = h[1].length;
        out.push('<h' + lv + '>' + renderInline(h[2]) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 表格
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        closeLists(-1);
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          var l = c.charAt(0) === ':';
          var r = c.charAt(c.length - 1) === ':';
          return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var html = '<div class="table-wrap"><table><thead><tr>';
        head.forEach(function (cell, idx) {
          var style = aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '';
          html += '<th' + style + '>' + renderInline(cell) + '</th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach(function (row) {
          html += '<tr>';
          for (var c = 0; c < head.length; c++) {
            var style2 = aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '';
            html += '<td' + style2 + '>' + renderInline(row[c] === undefined ? '' : row[c]) + '</td>';
          }
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // 引用
      if (RE_QUOTE.test(line)) {
        closeLists(-1);
        var quote = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          quote.push(lines[i].replace(RE_QUOTE, ''));
          i++;
        }
        out.push('<blockquote>' + render(quote.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表
      var ul = line.match(RE_UL);
      var ol = ul ? null : line.match(RE_OL);
      if (ul || ol) {
        var type = ul ? 'ul' : 'ol';
        var indent = indentOf((ul || ol)[1]);
        var parts = [(ul || ol)[2]];
        i++;

        // 列表项的续行
        while (i < lines.length) {
          var next = lines[i];
          if (!next.trim()) break;
          if (RE_UL.test(next) || RE_OL.test(next)) break;
          if (RE_BLOCK_START.test(next) || RE_HR.test(next)) break;
          if (indentOf(next.match(/^\s*/)[0]) <= indent) break;
          parts.push(next.trim());
          i++;
        }

        closeLists(indent); // 先关掉比当前更深的层级

        var cur = stack[stack.length - 1];
        if (cur && cur.indent === indent) {
          if (cur.type === type) {
            out.push('</li><li>');
          } else {
            stack.pop();
            out.push('</li></' + cur.type + '>');
            openList(type, indent);
          }
        } else {
          openList(type, indent);
        }
        out.push(renderInline(parts.join('\n')));
        continue;
      }

      // 段落
      closeLists(-1);
      var para = [line];
      i++;
      while (i < lines.length) {
        var l2 = lines[i];
        if (!l2.trim()) break;
        if (RE_HEADING.test(l2) || RE_QUOTE.test(l2) || RE_HR.test(l2)) break;
        if (RE_UL.test(l2) || RE_OL.test(l2)) break;
        if (l2.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
        if (/^\u0000BLOCK\d+\u0000$/.test(l2)) break;
        para.push(l2);
        i++;
      }
      out.push('<p>' + renderInline(para.join('\n')) + '</p>');
    }

    closeLists(-1);
    return out.join('\n');
  }

  global.MarkdownLite = { render: render, escapeHtml: escapeHtml };
})(window);
