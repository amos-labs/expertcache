export function parseLlamaTimingLog(text) {
  const patterns = {
    prompt: /prompt eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens[^\n]*?([\d.]+) tokens per second\)/g,
    decode: /(?<!prompt )eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens[^\n]*?([\d.]+) tokens per second\)/g,
    total: /total time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens/g
  };
  const prompt = lastMatch(text, patterns.prompt);
  const decode = lastMatch(text, patterns.decode);
  const total = lastMatch(text, patterns.total);
  return {
    prompt: prompt ? {
      milliseconds: Number(prompt[1]),
      tokens: Number(prompt[2]),
      tokens_per_second: Number(prompt[3])
    } : null,
    decode: decode ? {
      milliseconds: Number(decode[1]),
      tokens: Number(decode[2]),
      tokens_per_second: Number(decode[3])
    } : null,
    total: total ? {
      milliseconds: Number(total[1]),
      tokens: Number(total[2])
    } : null
  };
}

function lastMatch(text, regex) {
  let latest = null;
  for (const match of String(text || "").matchAll(regex)) latest = match;
  return latest;
}
