#!/usr/bin/env node

import { createProgram } from "./cli";

const program = createProgram();
program.parse(process.argv);
