import { promises as fs } from 'node:fs';
import { PerformanceMetrics } from './observabilityUtil.js';

export interface MetricsSnapshot {
  timestamp: string;
  metrics: PerformanceMetrics;
}

export async function exportMetrics(metrics: PerformanceMetrics, filepath: string): Promise<void> {
  const snapshot: MetricsSnapshot = {
    timestamp: new Date().toISOString(),
    metrics,
  };

  try {
    const data = JSON.stringify(snapshot, null, 2);
    await fs.appendFile(filepath, data + '\n');
  } catch (error) {
    console.error('Failed to export metrics:', error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function loadMetricsHistory(filepath: string): Promise<MetricsSnapshot[]> {
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    return data.split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as MetricsSnapshot);
  } catch (error) {
    console.error('Failed to load metrics history:', error instanceof Error ? error.message : 'Unknown error');
    return [];
  }
}

export function calculateMemoryGrowth(history: MetricsSnapshot[]): number {
  if (history.length < 2) return 0;
  const initialMemory = history[0].metrics.memory.usedMemory;
  const finalMemory = history[history.length - 1].metrics.memory.usedMemory;
  return finalMemory - initialMemory;
}

export function calculateAverageCpuUsage(history: MetricsSnapshot[]): number {
  if (history.length === 0) return 0;
  const totalCpuUsage = history.reduce((acc, snapshot) => {
    const averageCpu = snapshot.metrics.cpu.reduce((cpuAcc, cpu) => {
      const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return cpuAcc + ((cpu.times.user + cpu.times.nice + cpu.times.sys) / total) * 100;
    }, 0);
    return acc + averageCpu / snapshot.metrics.cpu.length;
  }, 0);
  return totalCpuUsage / history.length;
}
