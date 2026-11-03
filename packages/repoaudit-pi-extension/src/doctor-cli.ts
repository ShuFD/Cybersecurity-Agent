#!/usr/bin/env node
import { runRepoAuditDoctor } from "./adapter/doctor.ts";

const result = await runRepoAuditDoctor();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
