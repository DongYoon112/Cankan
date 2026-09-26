// Loads required service configuration from environment variables or secret files.
import { readFileSync } from 'node:fs';

export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  if (!value) throw new Error(`Missing ${name} or ${name}_FILE`);
  return value;
}
