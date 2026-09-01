#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
function isLongMultiStage(prompt) {
  const text = prompt.trim().toLowerCase();
  if (text.length < 40) return false;
  const stages = [...text.matchAll(/\b(?:audit|analy[sz]e|inspect|implement|fix|test|verify|refactor|review|document|build|create|update|migrate|debug)\b|(?:аудит|проанализ|проверь|исправ|реализ|добав|протест|рефактор|документ|подготов|сделай|создай|настрой|обнов|внедр|мигрир|исслед|разработ)/giu)].length;
  return text.length >= 240 || stages >= 2 || /(?:многоэтап|долг(?:ая|ий|ую)|нескольк(?:о|их) этап|сначала.+(?:потом|затем))/iu.test(text);
}

export function hookOutputForPrompt(prompt) {
  if (typeof prompt !== 'string' || !isLongMultiStage(prompt)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Automatically use $skillstate-runtime for this long, multi-stage turn. Start with skillstate doctor, preserve the existing authority limits, and continue normally only if the task is actually one-step. This hook adds routing context only: it does not start a process, edit files, or grant authority.'
    }
  };
}

function startHook() {
  let input = '';
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    try {
      const prompt = JSON.parse(input.replace(/^\uFEFF/, '')).prompt;
      process.stdout.write(JSON.stringify(hookOutputForPrompt(prompt)));
    } catch {
      process.stdout.write('{}');
    }
  }
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  process.stdin.resume();
  const timeout = setTimeout(finish, 1000);
  process.stdin.once('end', () => clearTimeout(timeout));
}

const hookPath = fileURLToPath(import.meta.url);
if (process.argv[1] === hookPath) startHook();
