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
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

interface ToolDef {
  id: string;
  title: string;
  Icon: LucideIcon;
  toggle: boolean;
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

export function RichTextEditor({ value, onChange, placeholder, readOnly = false }: RichTextEditorProps) {
  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Highlight,
      Placeholder.configure({ placeholder: placeholder ?? 'Escreva aqui…' }),
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

  useEffect(() => {
    if (!editor) return;
    const current = editor.storage.markdown.getMarkdown();
    if (value !== current) {
      editor.commands.setContent(value, false);
    }
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [readOnly, editor]);

  const isEmptyView = readOnly && value.trim().length === 0;

  return (
    <div
      className={
        readOnly
          ? 'rounded-lg overflow-hidden'
          : 'rounded-lg overflow-hidden bg-zinc-950 ring-1 ring-zinc-800 transition-shadow duration-150 ease-[cubic-bezier(0.16,0.84,0.44,1)] focus-within:ring-2 focus-within:ring-brand-400/60'
      }
    >
      {!readOnly && editor && <Toolbar editor={editor} />}
      {isEmptyView ? (
        <p className="px-4 py-6 text-sm italic text-zinc-600">
          Sem conteúdo ainda — toque em “Editar” para escrever.
        </p>
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
