#!/usr/bin/env node
import process from 'node:process';
import './sqlite-quiet.js';

const { runCli } = await import('../dist/cli/main.js');
process.exitCode = await runCli(process.argv.slice(2));
