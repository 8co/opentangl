export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60));

  const components: string[] = [];
  
  if (hours > 0) {
    components.push(`${hours}h`);
  }
  if (minutes > 0 || (hours > 0 && seconds > 0)) {  // include '0m' if there are seconds
    components.push(`${minutes}m`);
  }
  if (seconds > 0 || components.length === 0) {  // include '0s' if no other components
    components.push(`${seconds}s`);
  }
  
  return components.join(' ');
}
