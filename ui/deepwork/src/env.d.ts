/// <reference types="vite/client" />
declare module 'elkjs/lib/elk.bundled.js' {
  import ELK from 'elkjs';
  export default ELK;
  export type { ElkNode } from 'elkjs';
}
