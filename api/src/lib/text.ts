/** "claude-haiku-5-5" -> "Claude Haiku 5.5", for messages people read. */
export function modelName(model: string): string {
  return model
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
