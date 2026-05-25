// ============================================================================
// RichTextEditor — editor WYSIWYG "estilo Word" pros campos de Fontes.
//
// POR QUE EXISTE
// --------------
// Os campos de Fontes alimentam o system prompt da IA. O usuário formata como
// no Word — títulos, negrito, listas, destaque — clicando em botões, SEM ver
// marcação. O `value` que entra/sai é **Markdown** (texto puro), então o
// conteúdo salvo continua limpo e o prompt-composer injeta direto, sem HTML.
//
// CRAFT (diretrizes "impeccable", register product)
// --------------------------------------------------
//  - Microinterações: barra segue o padrão WAI-ARIA de `role="toolbar"` com
//    roving tabindex (Tab entra UMA vez, setas navegam). Cada botão tem os
//    estados default/hover/active/focus-visible/disabled e distingue *toggle*
//    (aria-pressed → preenchido) de *press* (:active → afunda 1px).
//  - Transições 150ms com ease-out exponencial (sem bounce).
//  - Cores sólidas e de alto contraste; alpha só em estados (foco/seleção).
//  - Tipografia/medida/ritmo do conteúdo vivem em index.css (.fontes-editor),
//    porque o conteúdo é contenteditable e não aceita classes utilitárias.
// ============================================================================

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Highlighter,
  Undo2,
  Redo2,
  type LucideIcon,
} from 'lucide-react';

interface RichTextEditorProps {
  /** Conteúdo em Markdown. */
  value: string;
  /** Recebe o Markdown atualizado a cada edição. */
  onChange: (markdown: string) => void;
  placeholder?: string;
}

// ---------------------------------------------------------------------------
// Descritores das ferramentas. Dirigir a barra por dados (em vez de JSX
// repetido) mantém o roving tabindex e os estados consistentes botão a botão —
// "mesma forma, mesmo vocabulário" que o register product exige.
// ---------------------------------------------------------------------------
interface ToolDef {
  id: string;
  title: string;
  Icon: LucideIcon;
  /** true = alterna um estado (usa aria-pressed); false = ação pontual. */
  toggle: boolean;
  /** Índice do grupo — fronteira de grupo vira um divisor fino. */
  group: number;
  isActive: (e: Editor) => boolean;
  isEnabled: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const TOOLS: ToolDef[] = [
  { id: 'bold', title: 'Negrito  (Ctrl+B)', Icon: Bold, toggle: true, group: 0,
    isActive: (e) => e.isActive('bold'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleBold().run() },
  { id: 'italic', title: 'Itálico  (Ctrl+I)', Icon: Italic, toggle: true, group: 0,
    isActive: (e) => e.isActive('italic'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleItalic().run() },
  { id: 'highlight', title: 'Destaque', Icon: Highlighter, toggle: true, group: 0,
    isActive: (e) => e.isActive('highlight'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleHighlight().run() },

  { id: 'h1', title: 'Título', Icon: Heading1, toggle: true, group: 1,
    isActive: (e) => e.isActive('heading', { level: 1 }), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', title: 'Subtítulo', Icon: Heading2, toggle: true, group: 1,
    isActive: (e) => e.isActive('heading', { level: 2 }), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },

  { id: 'ul', title: 'Lista com marcadores', Icon: List, toggle: true, group: 2,
    isActive: (e) => e.isActive('bulletList'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ol', title: 'Lista numerada', Icon: ListOrdered, toggle: true, group: 2,
    isActive: (e) => e.isActive('orderedList'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'quote', title: 'Citação', Icon: Quote, toggle: true, group: 2,
    isActive: (e) => e.isActive('blockquote'), isEnabled: () => true,
    run: (e) => e.chain().focus().toggleBlockquote().run() },

  { id: 'undo', title: 'Desfazer  (Ctrl+Z)', Icon: Undo2, toggle: false, group: 3,
    isActive: () => false, isEnabled: (e) => e.can().undo(),
    run: (e) => e.chain().focus().undo().run() },
  { id: 'redo', title: 'Refazer  (Ctrl+Shift+Z)', Icon: Redo2, toggle: false, group: 3,
    isActive: () => false, isEnabled: (e) => e.can().redo(),
    run: (e) => e.chain().focus().redo().run() },
];

// Estados completos num só lugar. Sólido por padrão; alpha só em foco/toggle
// (exceção permitida pra estados). ease-out-quart, 150ms.
const BTN_CLASS = [
  'inline-flex items-center justify-center h-8 w-8 rounded-md text-zinc-400',
  'transition-[color,background-color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.16,0.84,0.44,1)]',
  'hover:text-zinc-100 hover:bg-zinc-800',
  'active:translate-y-px',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900',
  'disabled:text-zinc-700 disabled:pointer-events-none',
  'aria-pressed:bg-brand-500/20 aria-pressed:text-brand-100 aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-brand-400/40',
].join(' ');

function Toolbar({ editor }: { editor: Editor }) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Roving tabindex: só UM botão é tabbable; setas movem o foco entre eles.
  const [roving, setRoving] = useState(0);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const stepTo = (from: number, dir: number) => {
        for (let n = 1; n <= TOOLS.length; n++) {
          const i = (from + dir * n + TOOLS.length) % TOOLS.length;
          if (TOOLS[i].isEnabled(editor)) return i;
        }
        return from;
      };
      let next = roving;
      if (e.key === 'ArrowRight') next = stepTo(roving, 1);
      else if (e.key === 'ArrowLeft') next = stepTo(roving, -1);
      else if (e.key === 'Home') next = stepTo(-1, 1);
      else if (e.key === 'End') next = stepTo(0, -1);
      setRoving(next);
      btnRefs.current[next]?.focus();
    },
    [roving, editor],
  );

  return (
    <div
      role="toolbar"
      aria-label="Formatação"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-2"
    >
      {TOOLS.map((t, i) => {
        const enabled = t.isEnabled(editor);
        const active = t.isActive(editor);
        const divider = i > 0 && t.group !== TOOLS[i - 1].group;
        return (
          <Fragment key={t.id}>
            {divider && <span className="mx-1 h-5 w-px bg-zinc-800" aria-hidden />}
            <button
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              title={t.title}
              aria-label={t.title}
              {...(t.toggle ? { 'aria-pressed': active } : {})}
              disabled={!enabled}
              tabIndex={i === roving ? 0 : -1}
              onFocus={() => setRoving(i)}
              // preventDefault no mousedown: não rouba a seleção do editor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => t.run(editor)}
              className={BTN_CLASS}
            >
              <t.Icon size={16} strokeWidth={2.25} />
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

export function RichTextEditor({ value, onChange, placeholder }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Highlight,
      Placeholder.configure({ placeholder: placeholder ?? 'Escreva aqui…' }),
      // Markdown: faz `content` (string) ser parseado como markdown e expõe
      // `editor.storage.markdown.getMarkdown()` pra serializar de volta.
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(editor.storage.markdown.getMarkdown());
    },
    editorProps: {
      attributes: { class: 'fontes-editor' },
    },
  });

  // Sincroniza quando o `value` muda POR FORA (troca de unidade / load inicial).
  // Comparar com o markdown atual evita resetar o conteúdo (e pular o cursor) a
  // cada tecla — durante a digitação `value` já é igual ao do editor.
  useEffect(() => {
    if (!editor) return;
    const current = editor.storage.markdown.getMarkdown();
    if (value !== current) {
      editor.commands.setContent(value, false);
    }
  }, [value, editor]);

  return (
    <div className="rounded-lg overflow-hidden bg-zinc-950 ring-1 ring-zinc-800 transition-shadow duration-150 ease-[cubic-bezier(0.16,0.84,0.44,1)] focus-within:ring-2 focus-within:ring-brand-400/60">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
