#!/usr/bin/env node
// Keep the scripted worker identifiable as Claude in the daemon's process
// table. The native reclaim path must stop it; an unrecognized Node script
// can keep running after its task ends and hold the next worker's slot.
import './fake-claude.mjs';
