export interface StreamPreview {
  turnId: string;
  text: string;
  truncated: boolean;
}

/** A bounded TUI preview, separate from authoritative persisted messages. */
export function streamPreview(lines: string[], turnId: string, previous: StreamPreview | null): StreamPreview | null {
  const marker = lines.findIndex(line => /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/u.test(line));
  if (lines.some(line => /Cline needs permission|Cline is asking a question|Press Enter to open/.test(line))) return null;
  if (marker >= 0) {
    const first = lines[marker].replace(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/u, '');
    if (!first || /^(Thinking|Working|Running|Executing)\.\.\.|\(esc to cancel\)/i.test(first)) return null;
    const body=[first,...lines.slice(marker+1).map(line=>line.replace(/^ {1,4}/,''))].join('\n').trimEnd();
    return {turnId,text:body.slice(0,65536),truncated:body.length>65536};
  }
  if (!previous || previous.turnId!==turnId) return null;
  // Long replies scroll their spinner off-screen. Merge only an exact overlapping
  // group of completed lines; unknown redraws retain the last observed preview.
  const window=lines.map(line=>line.replace(/^ {1,4}/,'')).join('\n').trimEnd().split('\n');
  const prior=previous.text.split('\n');
  for(let drop=0;drop<=1;drop++) {
    const base=drop?prior.slice(0,-1):prior;
    for(let count=Math.min(base.length,window.length);count>=2;count--) {
      if(base.slice(-count).join('\n')!==window.slice(0,count).join('\n'))continue;
      const text=[...base,...window.slice(count)].join('\n');
      return {turnId,text:text.slice(0,65536),truncated:previous.truncated||text.length>65536};
    }
  }
  return {...previous,truncated:true};
}
