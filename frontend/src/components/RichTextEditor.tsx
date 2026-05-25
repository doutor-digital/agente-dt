// ============================================================================
// RichTextEditor — editor WYSIWYG "estilo Word" pros campos de Fontes.
//
// POR QUE EXISTE
// --------------
// Os campos de Fontes alimentam o system prompt da IA. Antes eram <textarea>
// de texto puro (feio, sem hierarquia visual). Aqui o usuário formata como no
// Word — títulos, negrito, listas, destaque — clicando em botões, SEM ver
// marcação nenhuma.
//
// CONTRATO IMPORTANTE
// -------------------
// O `value` que entra e o que sai do `onChange` são **Markdown** (texto puro),
// não HTML. Assim o conteúdo salvo no banco continua limpo e legível, e o
// prompt-composer do backend injeta direto sem precisar de parser de HTML.
// O TipTap renderiza esse markdown bonito na tela e serializa de volta no save.
// ============================================================================

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import { useEffect } from 'react';
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
} from 'lucide-react';

interface RichTextEditorProps {
  /** Conteúdo em Markdown. */
  value: string;
  /** Recebe o Markdown atualizado a cada edição. */
  onChange: (markdown: string) => void;
  placeholder?: string;
}

// ---------------------------------------------------------------------------
// Botão da barra de ferramentas. `active` pinta no tom da marca quando a
// formatação está aplicada na seleção atual (feedback estilo Word).
// ---------------------------------------------------------------------------
function ToolButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // onMouseDown + preventDefault: não rouba o foco/seleção do editor ao clicar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={
        'inline-flex items-center justify-center h-8 w-8 rounded-md transition ' +
        'disabled:opacity-30 disabled:cursor-not-allowed ' +
        (active
          ? 'bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/40'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70')
      }
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-zinc-800" aria-hidden />;
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
      <ToolButton
        title="Negrito (Ctrl+B)"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={16} />
      </ToolButton>
      <ToolButton
        title="Itálico (Ctrl+I)"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={16} />
      </ToolButton>
      <ToolButton
        title="Destaque"
        active={editor.isActive('highlight')}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
      >
        <Highlighter size={16} />
      </ToolButton>

      <Divider />

      <ToolButton
        title="Título"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={16} />
      </ToolButton>
      <ToolButton
        title="Subtítulo"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={16} />
      </ToolButton>

      <Divider />

      <ToolButton
        title="Lista com marcadores"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={16} />
      </ToolButton>
      <ToolButton
        title="Lista numerada"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={16} />
      </ToolButton>
      <ToolButton
        title="Citação"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={16} />
      </ToolButton>

      <Divider />

      <ToolButton
        title="Desfazer (Ctrl+Z)"
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 size={16} />
      </ToolButton>
      <ToolButton
        title="Refazer (Ctrl+Y)"
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 size={16} />
      </ToolButton>
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
      attributes: {
        class: 'fontes-editor focus:outline-none px-4 py-3 min-h-[220px]',
      },
    },
  });

  // Sincroniza quando o `value` muda POR FORA (ex: troca de unidade / load
  // inicial). Comparamos com o markdown atual pra NÃO resetar o conteúdo (e
  // pular o cursor) a cada tecla — durante a digitação `value` já é igual ao
  // que o editor tem, então o setContent não roda.
  useEffect(() => {
    if (!editor) return;
    const current = editor.storage.markdown.getMarkdown();
    if (value !== current) {
      editor.commands.setContent(value, false);
    }
  }, [value, editor]);

  return (
    <div className="rounded-lg overflow-hidden ring-1 ring-zinc-800 focus-within:ring-brand-500/40 bg-zinc-950/60 transition">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
