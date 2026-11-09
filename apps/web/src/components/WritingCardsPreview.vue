<script setup lang="ts">
import { writingCardKindLabels, type WritingCard } from '@creator-ai/contracts';
defineProps<{ cards: WritingCard[] }>();
</script>

<template>
  <div class="writing-preview">
    <p v-if="!cards.length" class="fine-print">尚未添加写作资料，使用账号基础人设。</p>
    <details v-for="card in cards" :key="card.id">
      <summary>
        {{ writingCardKindLabels[card.kind] }} · {{ card.title
        }}{{ card.enabled ? '' : '（停用）' }}
      </summary>
      <pre>{{ card.content }}</pre>
    </details>
  </div>
</template>

<style scoped>
details {
  margin-block: 10px;
}
summary {
  cursor: pointer;
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
pre {
  font: inherit;
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow-y: auto;
  padding: 12px;
  background: var(--sage);
  border-radius: 8px;
}
</style>
