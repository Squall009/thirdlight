# Objects and components

## Objects

Everything in a scene is an **object** (an *entity* in the API): the
ground, a crate, a light, the camera, the player, a spawn point. An object
has:

- an **id**, fixed for its life, unique in the project;
- a **name**, shown in the Hierarchy;
- an optional **parent**: objects form a tree, and a child moves with its
  parent;
- **flags**: *Active* (in the game at all), *Visible* (drawn), *Locked*
  (not selectable in the Scene view), *Static* (never moves, so lighting can
  be baked and drawing is cheaper) and *Keep loaded* (survives scene
  changes);
- **tags** from the project's tag list, for scripts to find objects by;
- its **components**.

The full list of fields is in the reference:
[object fields](../reference/objects.md#entity).

## Components

A component is one piece of what an object is or does. The Crate in the
Starter has three: a **Transform** (where it is), a **Box** (what it looks
like) and a **Collider** (what it bumps into). The Player has a Model, a
**Player controller** (it walks and jumps with the input) and an
**Animator**.

An object has at most one component of each kind. Some kinds exclude each
other (an object shows one model or one box), and some need another (a
surface needs a box or a model).

The engine has forty kinds, in ten categories: Object, Rendering,
Physics, Camera, Lighting, Gameplay, Audio, Animation, Scripting and
Organisation. Block layers, terrain, splines and generated architecture are
components too. The reference lists every kind and
every field with its unit, range and default:
[components](../reference/objects.md#component-index).

The Gameplay components are building blocks, not rules: a trigger reports
that something entered it, a collectible counts into a named counter, a
health component reports damage and death. What that *means* (a lost life,
a score, an opened door) is decided by your scripts. See
[scripts and the step model](scripts-and-the-step-model.md).

## In the editor

- **GameObject** menu: create a folder, an empty object, a box, a light, a
  camera (GameObject → Cameras), a model from an asset, an instance set, a
  block layer, terrain or a prefab copy.
- The **Inspector** shows the selected object: its name, flags and tags,
  then one section per component. Every field has a control, with its unit
  in the label and what it does in the tooltip. A field left at its engine
  default shows its label in italics.
- **+ Add component** (or the **Component** menu) adds one. Kinds you cannot
  add are greyed out with the reason.
- Each section has **remove**.
- Things with a size, range, direction or path also have handles in the
  Scene view.

Every edit is one command and one step of undo. A refused edit says why
under its section and changes nothing.

## Through the API

- [`createEntity`](../reference/ops-detail.md#op-createEntity) makes an
  object in a scene (or under a parent);
  [`createEntities`](../reference/ops-detail.md#op-createEntities) makes
  many in one command.
- [`setComponent`](../reference/ops-detail.md#op-setComponent) sets a
  component's fields; a `null` value removes the component.
- [`setTransform`](../reference/ops-detail.md#op-setTransform) moves,
  turns or scales an object.
- [`updateEntity`](../reference/ops-detail.md#op-updateEntity) renames it,
  changes its parent, its flags or its tags.
- [`deleteEntity`](../reference/ops-detail.md#op-deleteEntity) removes it.

Scripts read and write components of objects in the running game with
[`ctx.entity`](../reference/script-api.md#ctx-entity). That changes the
game, never the project.

Related: [prefabs](prefabs.md), [projects and scenes](projects-and-scenes.md).
