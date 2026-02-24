import os from 'os';
import { appendFileSync } from 'fs';

export interface MemoryUsage {
  totalMemory: number;
  freeMemory: number;
  usedMemory: number;
}

export interface CpuUsage {
  model: string;
  speed: number;
  times: {
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  };
}

export interface DiskUsage {
  total: number;
  free: number;
  used: number;
}

export interface PerformanceMetrics {
  memory: MemoryUsage;
  cpu: CpuUsage[];
  disk: DiskUsage;
}

function logError(message: string, error: unknown): void {
  console.error(`${message}:`, error instanceof Error ? error.message : error);
}

function logToCentralizedSystem(message: string): void {
  try {
    appendFileSync('system.log', `${new Date().toISOString()} - ${message}\n`);
  } catch (error: unknown) {
    logError('Failed to log to centralized system', error);
  }
}

export function getMemoryUsage(): MemoryUsage {
  try {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    return {
      totalMemory,
      freeMemory,
      usedMemory,
    };
  } catch (error: unknown) {
    logError('Failed to retrieve memory usage', error);
    return {
      totalMemory: 0,
      freeMemory: 0,
      usedMemory: 0,
    };
  }
}

export function getCpuUsage(): CpuUsage[] {
  try {
    return os.cpus().map(cpu => ({
      model: cpu.model,
      speed: cpu.speed,
      times: {
        user: cpu.times.user,
        nice: cpu.times.nice,
        sys: cpu.times.sys,
        idle: cpu.times.idle,
        irq: cpu.times.irq,
      },
    }));
  } catch (error: unknown) {
    logError('Failed to retrieve CPU usage', error);
    return [];
  }
}

export function getDiskUsage(): DiskUsage {
  // This function is a placeholder as Node.js does not natively support disk usage
  // In a real-world scenario, you would call an external package or OS command to get disk usage
  // For the sake of this example, we will provide dummy data
  return {
    total: 500 * 1024 * 1024 * 1024,  // 500 GB
    free: 200 * 1024 * 1024 * 1024,   // 200 GB
    used: 300 * 1024 * 1024 * 1024    // 300 GB
  };
}

export function generatePerformanceMetrics(): PerformanceMetrics {
  try {
    const metrics = {
      memory: getMemoryUsage(),
      cpu: getCpuUsage(),
      disk: getDiskUsage(),
    };

    logPerformanceMetrics(metrics);
    return metrics;
  } catch (error: unknown) {
    logError('Failed to generate performance metrics', error);
    return {
      memory: {
        totalMemory: 0,
        freeMemory: 0,
        usedMemory: 0,
      },
      cpu: [],
      disk: {
        total: 0,
        free: 0,
        used: 0,
      },
    };
  }
}

export function logPerformanceMetrics(metrics: PerformanceMetrics): void {
  const message = `
    Memory Usage: Total - ${metrics.memory.totalMemory}, Free - ${metrics.memory.freeMemory}, Used - ${metrics.memory.usedMemory}
    CPU Usage: ${JSON.stringify(metrics.cpu, null, 2)}
    Disk Usage: Total - ${metrics.disk.total}, Free - ${metrics.disk.free}, Used - ${metrics.disk.used}
  `;
  logToCentralizedSystem(message.trim());
}
