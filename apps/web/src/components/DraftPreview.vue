<script setup lang="ts">
import { watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import type { DocumentNode } from '@creator-ai/contracts';

const props = defineProps<{ document: DocumentNode }>();
const editor = useEditor({
  extensions: [StarterKit],
  content: props.document,
  editable: false,
  editorProps: { attributes: { 'aria-label': '草稿正文（只读）', class: 'draft-body' } },
});
watch(
  () => props.document,
  (value) => editor.value?.commands.setContent(value, { emitUpdate: false }),
);
</script>

<template><EditorContent :editor="editor" /></template>
