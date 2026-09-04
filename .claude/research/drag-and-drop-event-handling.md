# Drag-and-drop event handling research

Research target: React source checkout at `0bbf02475c7b61a618551f1cf10c9bebf336f285`.

## Findings

- React registers the native drag events as ordinary delegated two-phase events and converts them through `SyntheticDragEvent`; `dataTransfer` is copied from the native event without an additional normalization layer.
- `dragstart`, `dragend`, and `drop` are discrete-priority events. `drag`, `dragenter`, `dragexit`, `dragleave`, and `dragover` are continuous-priority events.
- Modern React does not pool synthetic events. `persist()` is a no-op, so a drag handler can safely pass the event data to the immediate state/update path used by the UI.
- React’s keyed reconciliation handles list movement independently of drag events. Reordered children should use stable, unique keys; physical environment/project references and scoped thread keys satisfy that requirement here.
- React’s native drag propagation tests cover capture/bubble ordering and `stopPropagation`, but use `MouseEvent` fixtures and do not validate browser `DataTransfer` payloads. The T3 implementation therefore continues to rely on dnd-kit’s pointer sensor rather than the HTML5 drag payload API.

## Application decision

Use dnd-kit pointer sensors with a distance activation threshold, stable namespaced IDs for repository groups and scoped threads, and explicit persistence after `onDragEnd`. Keep group and thread order independent: group drops update the existing physical project order, while thread drops update a scoped UI-owned thread order.

Sources inspected in the local React checkout:

- `packages/react-dom-bindings/src/events/DOMEventProperties.js`
- `packages/react-dom-bindings/src/events/plugins/SimpleEventPlugin.js`
- `packages/react-dom-bindings/src/events/SyntheticEvent.js`
- `packages/react-dom-bindings/src/events/ReactDOMEventListener.js`
- `packages/react-dom-bindings/src/events/DOMPluginEventSystem.js`
- `packages/react-reconciler/src/ReactChildFiber.js`
- `packages/react-dom/src/__tests__/ReactDOMEventPropagation-test.js`
