import { autocompletion } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";

import { editorKeys } from "@/features/keymap";
import type { ErrorDto, Target } from "@/ipc/bindings/protocol";
import { dispatch } from "@/ipc/client";
import { editorTheme } from "@/theme/codemirror";

const listener = new Compartment();
const language = new Compartment();
const setStatement = StateEffect.define<[number, number] | undefined>();
const statementMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setStatement)) {
        return effect.value
          ? Decoration.set(Decoration.mark({ class: "cm-statement" }).range(...effect.value))
          : Decoration.none;
      }
    }
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface EditorHandle {
  target: () => Target;
  text: () => string;
  focus: () => void;
}

export interface EditorDiagnostic {
  error: ErrorDto;
  span: [number, number];
  text: string;
}

interface SqlEditorProps {
  ref?: Ref<EditorHandle>;
  text: string;
  diagnostic?: EditorDiagnostic;
  schema?: SQLNamespace;
  defaultSchema?: string;
  onChange: (text: string) => void;
  savedState: { current: EditorState | null };
}

export function SqlEditor({
  ref,
  text,
  diagnostic,
  schema,
  defaultSchema,
  onChange,
  savedState,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ text, onChange });
  useLayoutEffect(() => {
    latest.current = { text, onChange };
  }, [text, onChange]);

  useImperativeHandle(
    ref,
    () => ({
      target() {
        const selection = view.current?.state.selection.main;
        if (!selection || selection.empty) return { cursor: selection?.head ?? 0 };
        return { selection: [selection.from, selection.to] };
      },
      focus: () => view.current?.focus(),
      text: () => view.current?.state.doc.toString() ?? latest.current.text,
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!host.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const highlight = () => {
      clearTimeout(timer);
      const currentRevision = ++revision;
      timer = setTimeout(() => {
        const editor = view.current;
        if (!editor) return;
        void dispatch("plan_query", {
          text: editor.state.doc.toString(),
          target: { cursor: editor.state.selection.main.head },
          mode: "statement",
          production: false,
        })
          .then((plan) => {
            if (currentRevision === revision && editor === view.current) {
              editor.dispatch({ effects: setStatement.of(plan.statements[0]) });
            }
          })
          .catch(() => {});
      }, 150);
    };
    const updates = EditorView.updateListener.of((update) => {
      if (update.docChanged) latest.current.onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) highlight();
    });
    const state =
      savedState.current?.update({ effects: listener.reconfigure(updates) }).state ??
      EditorState.create({
        doc: latest.current.text,
        extensions: [
          language.of(sql({ dialect: PostgreSQL })),
          autocompletion(),
          history(),
          lineNumbers(),
          foldGutter(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          editorKeys,
          EditorState.allowMultipleSelections.of(true),
          EditorView.clickAddsSelectionRange.of((event) => event.altKey),
          EditorView.contentAttributes.of({ "aria-label": "SQL editor", spellcheck: "false" }),
          statementMarks,
          editorTheme,
          listener.of(updates),
        ],
      });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    highlight();
    return () => {
      clearTimeout(timer);
      revision++;
      savedState.current = editor.state;
      editor.destroy();
      view.current = null;
    };
  }, [savedState]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: language.reconfigure(sql({ dialect: PostgreSQL, schema, defaultSchema })),
    });
  }, [schema, defaultSchema]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!diagnostic || diagnostic.text !== editor.state.doc.toString()) {
      editor.dispatch(setDiagnostics(editor.state, []));
      return;
    }
    const {
      error,
      span: [start, end],
    } = diagnostic;
    const offset = error.position ?? 0;
    const from = Math.min(end, start + offset);
    editor.dispatch(
      setDiagnostics(editor.state, [
        { from, to: Math.min(end, from + 1), severity: "error", message: error.message },
      ]),
    );
  }, [diagnostic]);

  return <div ref={host} className="sql-editor" />;
}
