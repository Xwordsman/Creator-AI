import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DraftPreview from './DraftPreview.vue';

describe('Tiptap preview', () => {
  it('renders stored JSON as read-only text, not executable markup', async () => {
    const wrapper = mount(DraftPreview, {
      props: {
        document: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('<script>alert(1)</script>'));
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('<script>alert(1)</script>');
    expect(wrapper.find('[contenteditable="false"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
