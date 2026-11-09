<script setup lang="ts">
import { watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import type { ContentSelection, DocumentNode } from '@creator-ai/contracts';
import type { Editor } from '@tiptap/vue-3';

const props = defineProps<{ modelValue: DocumentNode; disabled: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: DocumentNode];
  selection: [value: ContentSelection | null];
}>();
function select(instance: Pick<Editor, 'state'>) {
  const { $from, $to, from, to } = instance.state.selection;
  if ($from.depth !== 1 || !$from.sameParent($to)) {
    emit('selection', null);
    return;
  }
  emit('selection', {
    blockIndex: $from.index(0),
    blockText: $from.parent.textContent,
    quote: instance.state.doc.textBetween(from, to).slice(0, 2000),
  });
}
function normalize(doc: DocumentNode): DocumentNode {
  return {
    ...doc,
    content: doc.content?.map((block) => ({ ...block, content: block.content ?? [] })),
  };
}
const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      bold: false,
      italic: false,
      strike: false,
      underline: false,
      link: false,
      code: false,
      codeBlock: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      hardBreak: false,
      horizontalRule: false,
      trailingNode: false,
    }),
  ],
  content: props.modelValue,
  editable: !props.disabled,
  editorProps: {
    attributes: {
      'aria-label': '内容正文编辑器',
      class: 'draft-body content-editor-body',
      role: 'textbox',
      'aria-multiline': 'true',
    },
  },
  onSelectionUpdate: ({ editor: instance }) => select(instance),
  onUpdate: ({ editor: instance }) => {
    emit('update:modelValue', normalize(instance.getJSON()));
    select(instance);
  },
});
watch(
  () => props.disabled,
  // Permission changes are not document edits (nor a reason to persist a local draft).
  (value) => editor.value?.setEditable(!value, false),
);
watch(
  () => props.modelValue,
  (value) => {
    if (
      editor.value &&
      JSON.stringify(normalize(editor.value.getJSON())) !== JSON.stringify(value)
    ) {
      editor.value.commands.setContent(value, { emitUpdate: false });
      emit('selection', null);
    }
  },
);
</script>

<template>
  <div class="content-editor">
    <div class="editor-toolbar" role="toolbar" aria-label="正文格式">
      <el-button
        :disabled="disabled"
        :aria-pressed="editor?.isActive('paragraph')"
        @click="editor?.chain().focus().setParagraph().run()"
        >正文</el-button
      >
      <el-button
        :disabled="disabled"
        :aria-pressed="editor?.isActive('heading', { level: 2 })"
        @click="editor?.chain().focus().setHeading({ level: 2 }).run()"
        >二级标题</el-button
      >
      <el-button
        :disabled="disabled"
        :aria-pressed="editor?.isActive('heading', { level: 3 })"
        @click="editor?.chain().focus().setHeading({ level: 3 }).run()"
        >三级标题</el-button
      >
      <el-button
        :disabled="disabled || !editor?.can().undo()"
        @click="editor?.chain().focus().undo().run()"
        >撤销</el-button
      >
      <el-button
        :disabled="disabled || !editor?.can().redo()"
        @click="editor?.chain().focus().redo().run()"
        >重做</el-button
      >
    </div>
    <EditorContent :editor="editor" />
    <p class="fine-print editor-caption">
      支持正文、二级与三级标题。粘贴时移除图片、链接和复杂样式；最多 200 个段落、20 万字。
    </p>
  </div>
</template>
