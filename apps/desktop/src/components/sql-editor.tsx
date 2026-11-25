import { autocompletion } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { MSSQL, PLSQL, PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { bracketMatching, foldGutter, syntaxTree } from "@codemirror/language";
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
import type { Connection, ErrorDto, Target } from "@/ipc/bindings/protocol";
import { dispatch } from "@/ipc/client";
import { editorTheme } from "@/theme/codemirror";

const listener = new Compartment();
const language = new Compartment();
const themeMode = new Compartment();
const dialects = { postgres: PostgreSQL, sqlserver: MSSQL, oracle: PLSQL };
const setNavigation = StateEffect.define<[number, number] | undefined>();
const navigationMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setNavigation)) {
        return effect.value
          ? Decoration.set(Decoration.mark({ class: "cm-navigation" }).range(...effect.value))
          : Decoration.none;
      }
    }
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});
export const setStatement = StateEffect.define<[number, number] | undefined>();

function statementDecoration(
  range: [number, number] | undefined,
  docLength: number,
): DecorationSet {
  if (!range) return Decoration.none;
  const [from, to] = range;
  if (from < 0 || from >= to || to > docLength) return Decoration.none;
  return Decoration.set(Decoration.mark({ class: "cm-statement" }).range(from, to));
}

export const statementMarks = StateField.define<{
  range?: [number, number];
  decorations: DecorationSet;
}>({
  create: () => ({ decorations: Decoration.none }),
  update(value, transaction) {
    let range = transaction.docChanged ? undefined : value.range;
    for (const effect of transaction.effects) {
      if (effect.is(setStatement)) {
        range = effect.value;
      }
    }
    const hasSelection = transaction.state.selection.ranges.some((selection) => !selection.empty);
    if (!range || hasSelection) {
      return value.range === range && value.decorations === Decoration.none
        ? value
        : { range, decorations: Decoration.none };
    }
    if (value.range === range && value.decorations !== Decoration.none) {
      return value;
    }
    return {
      range,
      decorations: statementDecoration(range, transaction.state.doc.length),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export interface EditorHandle {
  target: () => Target;
  text: () => string;
  focus: () => void;
  insert: (value: string) => void;
  replace: (value: string, range?: [number, number]) => void;
}

export interface EditorDiagnostic {
  error: ErrorDto;
  span: [number, number];
  text: string;
}

interface SqlEditorProps {
  ref?: Ref<EditorHandle>;
  text: string;
  dark?: boolean;
  diagnostic?: EditorDiagnostic;
  schema?: SQLNamespace;
  defaultSchema?: string;
  kind?: Connection["kind"];
  onNavigate?: (offset: number, full: boolean) => void;
  onChange: (text: string) => void;
  savedState: { current: EditorState | null };
}

export function SqlEditor({
  ref,
  text,
  dark = false,
  diagnostic,
  schema,
  defaultSchema,
  kind = "postgres",
  onNavigate,
  onChange,
  savedState,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ text, dark, schema, defaultSchema, onChange, onNavigate, kind });
  useLayoutEffect(() => {
    latest.current = { text, dark, schema, defaultSchema, onChange, onNavigate, kind };
  }, [text, dark, schema, defaultSchema, onChange, onNavigate, kind]);

  useImperativeHandle(
    ref,
    () => ({
      target() {
        const selection = view.current?.state.selection.main;
        if (!selection || selection.empty) return { cursor: selection?.head ?? 0 };
        return { selection: [selection.from, selection.to] };
      },
      focus: () => view.current?.focus(),
      insert(value) {
        const editor = view.current;
        if (!editor) return;
        editor.dispatch(editor.state.replaceSelection(value));
        editor.focus();
      },
      replace(value, range) {
        const editor = view.current;
        if (editor)
          editor.dispatch({
            changes: {
              from: range?.[0] ?? 0,
              to: range?.[1] ?? editor.state.doc.length,
              insert: value,
            },
          });
      },
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
      if (view.current?.state.selection.ranges.some((selection) => !selection.empty)) return;
      timer = setTimeout(() => {
        const editor = view.current;
        if (!editor || editor.state.selection.ranges.some((selection) => !selection.empty)) return;
        void dispatch("plan_query", {
          text: editor.state.doc.toString(),
          target: { cursor: editor.state.selection.main.head },
          mode: "statement",
          production: false,
          kind: latest.current.kind,
        })
          .then((plan) => {
            if (currentRevision === revision && editor === view.current) {
              editor.dispatch({ effects: setStatement.of(plan.statements[0]) });
            }
          })
          .catch(() => {});
      }, 150);
    };
    let hovered: [number, number] | undefined;
    let point: [number, number] | undefined;
    function mark(editor: EditorView, modifier: boolean) {
      const offset = modifier && point ? editor.posAtCoords({ x: point[0], y: point[1] }) : null;
      let range: [number, number] | undefined;
      if (offset !== null) {
        const identifier = syntaxTree(editor.state).resolveInner(offset, 1);
        if (identifier.name.endsWith("Identifier")) range = [identifier.from, identifier.to];
      }
      if (range?.[0] === hovered?.[0] && range?.[1] === hovered?.[1]) return;
      hovered = range;
      editor.dispatch({ effects: setNavigation.of(range) });
    }
    const updates = [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) highlight();
      }),
      EditorView.domEventHandlers({
        mousemove(event, editor) {
          point = [event.clientX, event.clientY];
          mark(editor, event.ctrlKey || event.metaKey);
        },
        mouseleave(_event, editor) {
          point = undefined;
          mark(editor, false);
        },
        keydown(event, editor) {
          if (event.key === "Control" || event.key === "Meta") mark(editor, true);
        },
        keyup(event, editor) {
          if (event.key === "Control" || event.key === "Meta") mark(editor, false);
        },
        mousedown(event, editor) {
          if (event.button !== 0 || event.altKey || !(event.ctrlKey || event.metaKey)) return false;
          const offset = editor.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null) return false;
          event.preventDefault();
          latest.current.onNavigate?.(offset, event.shiftKey);
          return true;
        },
      }),
    ];
    const initialLanguage = sql({
      dialect: dialects[latest.current.kind],
      schema: latest.current.schema,
      defaultSchema: latest.current.defaultSchema,
    });
    const initialThemeMode = EditorView.darkTheme.of(latest.current.dark);
    const state =
      savedState.current?.update({
        effects: [
          listener.reconfigure(updates),
          language.reconfigure(initialLanguage),
          themeMode.reconfigure(initialThemeMode),
        ],
      }).state ??
      EditorState.create({
        doc: latest.current.text,
        extensions: [
          language.of(initialLanguage),
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
          navigationMarks,
          themeMode.of(initialThemeMode),
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
      effects: language.reconfigure(sql({ dialect: dialects[kind], schema, defaultSchema })),
    });
  }, [schema, defaultSchema, kind]);

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: themeMode.reconfigure(EditorView.darkTheme.of(dark)),
    });
  }, [dark]);

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
    const offset =
      error.position ??
      (error.line && error.line > 1
        ? diagnostic.text
            .slice(start, end)
            .split("\n")
            .slice(0, error.line - 1)
            .join("\n").length + 1
        : 0);
    const from = Math.min(end, start + offset);
    editor.dispatch(
      setDiagnostics(editor.state, [
        { from, to: Math.min(end, from + 1), severity: "error", message: error.message },
      ]),
    );
  }, [diagnostic]);

  return <div ref={host} className="sql-editor" />;
}
