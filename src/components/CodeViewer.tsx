import { useEffect, useRef } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('cpp', cpp);

interface CodeViewerProps {
  code: string;
  filename: string;
  highlightedStartLine?: number;
  highlightedEndLine?: number;
}

function clampRange(
  startLine: number | undefined,
  endLine: number | undefined,
  totalLines: number,
): { start: number; end: number } | null {
  if (!startLine || startLine <= 0 || totalLines <= 0) {
    return null;
  }
  const start = Math.max(1, Math.min(totalLines, Math.floor(startLine)));
  const rawEnd = endLine && endLine > 0 ? Math.floor(endLine) : start;
  const end = Math.max(start, Math.min(totalLines, rawEnd));
  return { start, end };
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'py':
      return 'python';
    case 'sh':
      return 'bash';
    case 'md':
      return 'markdown';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'hpp':
      return 'cpp';
    default:
      return 'javascript';
  }
}

export default function CodeViewer({
  code,
  filename,
  highlightedStartLine,
  highlightedEndLine,
}: CodeViewerProps) {
  const language = getLanguage(filename);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineCount = code ? code.split('\n').length : 0;
  const range = clampRange(highlightedStartLine, highlightedEndLine, lineCount);

  useEffect(() => {
    if (!containerRef.current || !range) {
      return;
    }

    const target = containerRef.current.querySelector<HTMLElement>(
      `[data-line-number="${range.start}"]`,
    );

    if (target) {
      target.scrollIntoView({ block: 'center' });
    }
  }, [code, range?.start, range?.end]);

  return (
    <div ref={containerRef} className="h-full overflow-auto bg-white">
      <style>
        {`
        @keyframes gce-highlight-pulse {
          0% { filter: saturate(1); }
          50% { filter: saturate(1.2); }
          100% { filter: saturate(1); }
        }
        `}
      </style>
      <SyntaxHighlighter
        language={language}
        style={oneLight}
        customStyle={{
          margin: 0,
          padding: '1.5rem',
          fontSize: '13px',
          fontFamily: 'var(--font-mono)',
          backgroundColor: 'transparent',
        }}
        showLineNumbers={true}
        wrapLines={true}
        lineNumberStyle={{
          minWidth: '3em',
          paddingRight: '1em',
          color: '#cbd5e1',
          textAlign: 'right',
        }}
        lineProps={(lineNumber) => {
          const active = !!range && lineNumber >= range.start && lineNumber <= range.end;
          const isStart = !!range && lineNumber === range.start;
          const isEnd = !!range && lineNumber === range.end;

          return {
            'data-line-number': lineNumber,
            style: active
              ? {
                  display: 'block',
                  backgroundColor: '#eef2ff',
                  borderLeft: '4px solid #6366f1',
                  paddingLeft: '10px',
                  marginLeft: '-10px',
                  boxShadow: isStart
                    ? 'inset 0 2px 0 rgba(79,70,229,0.35), inset 0 -1px 0 rgba(79,70,229,0.15)'
                    : isEnd
                      ? 'inset 0 -2px 0 rgba(79,70,229,0.35), inset 0 1px 0 rgba(79,70,229,0.15)'
                      : 'inset 0 1px 0 rgba(79,70,229,0.08)',
                  animation: 'gce-highlight-pulse 420ms ease-in-out 1',
                }
              : { display: 'block' },
          };
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
