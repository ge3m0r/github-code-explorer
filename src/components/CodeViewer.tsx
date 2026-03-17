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

  useEffect(() => {
    if (!containerRef.current || !highlightedStartLine) {
      return;
    }

    const target = containerRef.current.querySelector<HTMLElement>(
      `[data-line-number="${highlightedStartLine}"]`,
    );

    if (target) {
      target.scrollIntoView({ block: 'center' });
    }
  }, [code, highlightedStartLine, highlightedEndLine]);

  return (
    <div ref={containerRef} className="h-full overflow-auto bg-white">
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
          const active =
            highlightedStartLine !== undefined &&
            lineNumber >= highlightedStartLine &&
            lineNumber <= (highlightedEndLine || highlightedStartLine);

          return {
            'data-line-number': lineNumber,
            style: active
              ? {
                  display: 'block',
                  backgroundColor: '#fff7d6',
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
