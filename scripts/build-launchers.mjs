// Build script for Windows executables (GUI and CLI launchers) using csc.exe
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const csc = findCsc();
if (!csc) {
  console.error('✖ csc.exe (C# Compiler) не найден в C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\');
  process.exit(1);
}

console.log('Компиляция Windows лаунчеров с помощью', csc);

// 1. GUI Launcher (Windows Forms, target:winexe)
const guiSrc = path.join(rootDir, 'src', 'launcher', 'Launcher.cs');
const guiExe = path.join(rootDir, 'site-blueprint.exe');
const distGuiExe = path.join(distDir, 'site-blueprint.exe');

if (fs.existsSync(guiSrc)) {
  try {
    console.log('• Сборка GUI лаунчера: site-blueprint.exe...');
    execFileSync(csc, [
      '/nologo',
      '/target:winexe',
      '/optimize',
      `/out:${guiExe}`,
      guiSrc
    ], { stdio: 'inherit' });
    fs.copyFileSync(guiExe, distGuiExe);
    console.log('  ✔ Готово: site-blueprint.exe и dist/site-blueprint.exe');
  } catch (err) {
    console.warn('  ! Не удалось перезаписать site-blueprint.exe (возможно, он сейчас открыт). Пропускаем.');
  }
}

// 2. CLI Launcher (Console app, target:exe)
const cliSrc = path.join(rootDir, 'src', 'launcher', 'CliLauncher.cs');
const cliExe = path.join(rootDir, 'sb.exe');
const cliNameExe = path.join(rootDir, 'site-blueprint-cli.exe');
const distCliExe = path.join(distDir, 'sb.exe');
const distCliNameExe = path.join(distDir, 'site-blueprint-cli.exe');

if (fs.existsSync(cliSrc)) {
  try {
    console.log('• Сборка CLI лаунчера: sb.exe / site-blueprint-cli.exe...');
    execFileSync(csc, [
      '/nologo',
      '/target:exe',
      '/optimize',
      `/out:${cliExe}`,
      cliSrc
    ], { stdio: 'inherit' });
    fs.copyFileSync(cliExe, cliNameExe);
    fs.copyFileSync(cliExe, distCliExe);
    fs.copyFileSync(cliExe, distCliNameExe);
    console.log('  ✔ Готово: sb.exe, site-blueprint-cli.exe и в dist/');
  } catch (err) {
    console.warn('  ! Ошибка сборки CLI лаунчера:', err.message);
  }
}

console.log('\n✔ Процесс сборки лаунчеров завершён.');
