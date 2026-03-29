/**
 * Simple file-based logger for pool operations
 * Writes to ~/.claude-code-router/logs/pool.log
 * Logs are written to file, not console
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class PoolLogger {
  private logDir: string;
  private logFile: string;
  private enabled: boolean = true;

  constructor() {
    this.logDir = path.join(os.homedir(), '.claude-code-router', 'logs');
    this.logFile = path.join(this.logDir, 'pool.log');
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch {
      // If we can't create the log directory, disable file logging
      this.enabled = false;
    }
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  }

  private write(level: LogLevel, message: string): void {
    if (!this.enabled) return;

    try {
      const formatted = this.formatMessage(level, message);
      fs.appendFileSync(this.logFile, formatted);
    } catch {
      // Silently fail if logging doesn't work
    }
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  log(message: string): void {
    this.info(message);
  }
}

// Singleton instance
export const poolLogger = new PoolLogger();