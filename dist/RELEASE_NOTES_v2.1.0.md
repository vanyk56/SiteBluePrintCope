# site-blueprint v2.1.0 🚀

Масштабный релиз с поддержкой **MCP-сервера (Cursor / Claude Code / Windsurf)**, **интерактивного Component Picker**, **консольного лаунчера `sb.exe`**, **адаптивной вёрстки Desktop + Mobile (`sm:` / `md:` / `lg:`)**, **Closed-Loop Visual Auto-Heal** и **эталонного бенчмарк-стенда**.

---

## 📦 Файлы для скачивания в этом релизе:

1. **`site-blueprint.exe`** — Графический лаунчер для Windows (Dark UI) с новыми кнопками **«🔌 MCP Конфиг»** и **«🩹 Heal проекта»**.
2. **`sb.exe` / `site-blueprint-cli.exe`** — Консольный лаунчер с интерактивным меню-мастером (7 режимов) и коротким синтаксисом (`sb cursor.com 2 10`).
3. **`site-blueprint-extension-v2.1.0.zip`** — Расширение для Chrome / Edge / Brave (Manifest V3) с интерактивным **Component Picker** (`🎯 Выбрать компонент`).

---

## ⚡ Главные нововведения v2.1.0:

### 🔌 1. Встроенный MCP-сервер (`site-blueprint mcp`)
Подключайте `site-blueprint` напрямую к **Cursor**, **Claude Code**, **Windsurf** или **Claude Desktop** как инструмент агента (Model Context Protocol, JSON-RPC 2.0 stdio):
- **Tools**: `clone_site`, `extract_design_tokens`, `pick_component`, `heal_project`, `verify_clone`.
- **Resources**: автоматический доступ агента ко всем сгенерированным `SITE_CLONE_BLUEPRINT.md` и `VERIFICATION_REPORT.md` через URI `blueprint://<run>/...`.
- **Prompts**: готовый промпт-шаблон `clone-website-1to1`.

```json
{
  "mcpServers": {
    "site-blueprint": {
      "command": "node",
      "args": ["C:/path/to/site-blueprint/bin/site-blueprint.mjs", "mcp"]
    }
  }
}
```

### 🎯 2. Интерактивный Component Picker (Browser Extension + CLI)
Нужен не весь сайт, а только конкретный **Hero**, **Navbar** или **Pricing Card**?
- **В расширении Chrome**: нажмите **«🎯 Выбрать компонент (JSX в буфер)»**, наведите курсор на любой блок (стрелки `↑`/`↓` переключают родителя/потомка) и кликните — чистый React + Tailwind v4 JSX со всеми `<svg>` путями мгновенно окажется в буфере обмена, с возможностью предпросмотра (`👁 Код`) и скачивания готового `.tsx` файла (`💾 .tsx`).
- **В CLI**:
  ```bash
  sb pick https://cursor.com "header" --name Navbar
  ```

### 📱 3. Настоящая адаптивность Desktop + Mobile (`sm:` / `md:` / `lg:`)
- Двухпроходное сопоставление дерева DOM между `desktop` (`1440×900`) и `mobile` (`390×844`) в `src/analyze/skeleton.mjs`.
- Автоматическая генерация адаптивных классов Tailwind CSS v4 (`flex-col lg:flex-row`, `grid-cols-1 lg:grid-cols-3`, `hidden lg:flex`, `text-2xl lg:text-5xl`).

### 🩹 4. Closed-Loop Visual Auto-Heal + CSS `@keyframes`
- Замкнутый цикл визуального самоисправления (`src/verify/visual-heal.mjs`): если после `pixelmatch`-сверки секция имеет `similarity < minSimilarity`, система делает бэкап `.tsx` в `verify/visual-heal-backup/`, устраняет переполнение (`max-w-full`) и вертикальный сдвиг (`min-h-[...]`), применяет точечный LLM-патч с эталонным снапшотом секции, пересобирает проект и выводит таблицу улучшений в `VERIFICATION_REPORT.md`.
- Извлечение и перенос оригинальных CSS `@keyframes` анимаций напрямую в `app/globals.css`.

### 💻 5. Простой CLI (`sb.exe` / `sb`) и локальный Benchmark Suite
- Запуск `sb` или `sb.exe` без аргументов открывает интерактивное меню (1–7).
- Короткая команда: `sb cursor.com 2 10` (глубина 2, до 10 страниц).
- Встроенный офлайн-бенчмарк (`npm run bench`) на 4 страницах с живыми API-ручками проверяет точность репродукции, сборку Next.js 16 и работу API-моков за секунды.
