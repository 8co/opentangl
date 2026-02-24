import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

interface JobStatus {
  id: string;
  status: string;
  startTime: string;
  endTime?: string;
}

export function listRunningJobs(): void {
  const jobs: JobStatus[] = loadRunningJobs();
  if (jobs.length === 0) {
    console.log('No running jobs found.');
  } else {
    console.log('Running Jobs:');
    jobs.forEach((job: JobStatus) => {
      console.log(`- [${job.id}] Status: ${job.status}, Started: ${job.startTime}`);
    });
  }
}

export function getJobLogs(jobId: string): void {
  const logsPath: string = path.resolve('logs', `${jobId}.log`);
  if (!fs.existsSync(logsPath)) {
    console.error(`No logs found for job ID: ${jobId}`);
    return;
  }

  const logs: string = fs.readFileSync(logsPath, 'utf8');
  console.log(`Logs for Job ID: ${jobId}\n${logs}`);
}

export function systemStatus(): void {
  const freeMemory: string = bytesToHumanReadable(os.freemem());
  const totalMemory: string = bytesToHumanReadable(os.totalmem());
  const uptime: number = os.uptime();
  const cpuUsage: string = getCpuUsage();
  const loadAverage: string = os.loadavg().map((avg: number) => avg.toFixed(2)).join(', ');

  console.log('System Status:');
  console.log(`- Free Memory: ${freeMemory}`);
  console.log(`- Total Memory: ${totalMemory}`);
  console.log(`- Uptime: ${formatUptime(uptime)}`);
  console.log(`- CPU Usage: ${cpuUsage}`);
  console.log(`- Load Average: ${loadAverage}`);
}

export function listJobIds(): void {
  const jobs: JobStatus[] = loadRunningJobs();
  if (jobs.length === 0) {
    console.log('No running jobs found.');
  } else {
    console.log('Running Job IDs:');
    jobs.forEach((job: JobStatus) => {
      console.log(`- ${job.id}`);
    });
  }
}

function loadRunningJobs(): JobStatus[] {
  const jobsDataPath: string = path.resolve('data', 'running_jobs.json');
  if (!fs.existsSync(jobsDataPath)) return [];

  const jobsData: string = fs.readFileSync(jobsDataPath, 'utf8');
  return JSON.parse(jobsData) as JobStatus[];
}

function bytesToHumanReadable(bytes: number): string {
  const units: string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index: number = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${bytes.toFixed(2)} ${units[index]}`;
}

function formatUptime(seconds: number): string {
  const days: number = Math.floor(seconds / 86400);
  const hours: number = Math.floor((seconds % 86400) / 3600);
  const minutes: number = Math.floor((seconds % 3600) / 60);
  const secs: number = Math.floor(seconds % 60);
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function getCpuUsage(): string {
  try {
    const result: string = execSync('top -b -n1 | grep "Cpu(s)"').toString();
    const usage: RegExpMatchArray | null = result.match(/(\d+\.\d+)\s+id/);
    const usagePercentage: string = usage ? (100 - parseFloat(usage[1])).toFixed(2) : 'N/A';
    return `${usagePercentage}% used`;
  } catch (error) {
    return 'Could not determine CPU usage';
  }
}
