import { Ipc } from '@opencode/plugin/gui';
import { Schema } from 'effect';

/**
 * Main-process read of OpenCode Desktop's own model favorites/recents.
 *
 * The UI must never read this database through a session's server filesystem:
 * favorites belong to the Desktop machine even when the active session points
 * at a remote server. The contract takes no input, so the window cannot choose
 * a path or database.
 */
export const NativeModelPrefsIpc = Ipc.define({
  id: 'oh-my-opencode-slim.native-model-prefs',
  methods: {
    read: {
      output: Schema.Struct({
        status: Schema.Literals(['ok', 'unavailable']),
        favorites: Schema.Array(Schema.String),
        recent: Schema.Array(Schema.String),
        updatedAt: Schema.optional(Schema.String),
      }),
    },
  },
});
