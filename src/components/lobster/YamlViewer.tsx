interface YamlViewerProps {
  content: string;
}

function highlightYaml(raw: string): JSX.Element[] {
  return raw.split('\n').map((line, i) => {
    if (line.trimStart().startsWith('#')) {
      return <span key={i} className="text-gray-600">{line}</span>;
    }
    const keyMatch = line.match(/^(\s*)([\w.-]+)(\s*:)(.*)/);
    if (keyMatch) {
      const [, indent, key, colon, rest] = keyMatch;
      return (
        <span key={i}>
          {indent}<span className="text-cyan-400">{key}</span><span className="text-gray-500">{colon}</span>
          <span className="text-amber-300">{rest}</span>
        </span>
      );
    }
    if (line.trimStart().startsWith('- ')) {
      const idx = line.indexOf('- ');
      return (
        <span key={i}>
          {line.slice(0, idx)}<span className="text-gray-500">- </span>
          <span className="text-gray-300">{line.slice(idx + 2)}</span>
        </span>
      );
    }
    return <span key={i} className="text-gray-300">{line}</span>;
  });
}

export function YamlViewer({ content }: YamlViewerProps) {
  const lines = highlightYaml(content);

  return (
    <div className="h-full overflow-auto bg-[#0d1117] p-4">
      <pre className="font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className="flex hover:bg-white/[0.02]">
            <span className="text-gray-700 select-none w-8 text-right pr-3 shrink-0 tabular-nums">{i + 1}</span>
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}
