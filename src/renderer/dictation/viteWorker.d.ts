// Vite's `?worker` import: the module bundled as its own worker script.
declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
