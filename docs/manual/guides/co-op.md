# Local co-op players

**Goal:** a second player on the same screen, with its own keys and its own
gamepad. Everything about several players:
[Several player controllers](../features/scenes-and-cameras.md#several-player-controllers-local-co-op).

Any object with a **Player controller** is a player. Players share the one
view; each has its own physics body, its own input actions and its own
state. Calls about "the player" default to the first controller (the first
in the scene's order), so a one-player game never names it.

## In the editor

1. **Actions for player 2.** **File → Project Settings… → Input**: add
   `move_p2` (*Axis (1D)*: **+ key** twice for left and right, for example
   Numpad 4 and 6, and a pad axis with **pad 2**) and `jump_p2` (*button*:
   a key and the pad's A button on **pad 2**). With a pad named, each
   player plays on a pad of their own; without, a binding reads the pad
   used last.
2. **The second character.** Select the Starter's player, **Edit →
   Duplicate**, move the copy aside, and in the Inspector set its Player
   controller's **Move action** to `move_p2` and **Jump action** to
   `jump_p2`. Keep it in a start scene and keep **Keep loaded** ticked.
3. **Scripts that name a player** pass its object id, for example
   `ctx.character.impulse([0, 6, 0], otherPlayerId)`,
   `ctx.lifecycle.respawn(spawnId, otherPlayerId)` or
   `ctx.game.health(otherPlayerId)`. Without an id they mean the first
   player.
4. **▶ play**: A/D moves the first player, Numpad 4/6 the second.

## Through the API

1. Add the actions with [`setInput`](../reference/ops-detail.md#op-setInput)
   (the whole list: the defaults plus yours, see [the input guide](input.md#through-the-api)):
   `{"name": "move_p2", "type": "axis1d", "map": "gameplay", "bindings": [{"kind": "keys1d", "negative": "Numpad4", "positive": "Numpad6"}, {"kind": "gamepadAxis", "axis": 0, "pad": 1}]}`
   and `{"name": "jump_p2", "type": "button", "map": "gameplay", "bindings": [{"kind": "key", "code": "Numpad8"}, {"kind": "gamepadButton", "button": 0, "pad": 1}]}`.
2. The second character ([`createEntity`](../reference/ops-detail.md#op-createEntity)):
   `{"sceneId": "scene-main", "kind": "model", "name": "Player 2", "keepLoaded": true, "transform": {"position": [5, 0.91, 0]}, "model": {"asset": {"assetId": "starter-character"}}, "components": {"controller": {"moveAction": "move_p2", "jumpAction": "jump_p2"}, "animator": {"controller": "idle-run-airborne-01"}}}`.
3. Play and observe: with several players `tl_game_observe` adds
   `players: [{id, x, y, z}]` (`player` stays the first one's). A frame
   `{"stepOffset": 0, "steps": 60, "actions": {"move_p2": {"v": 1, "p": "none"}}}`
   moves only the second.

## Which to use

Set up actions and the second character in the editor, where **+ key** and
**+ pad** listen for the real device and you can test with two pads. Use
the API to check both players' moves in a play-test.

## Pitfalls

- **Every player must be in a start scene.** A player's body is made when
  the game starts; a player in a scene loaded later (or a spawned copy)
  gets none and Play warns (`player_scene`).
- **Players pass through each other** and are never hit by raycasts or
  overlap queries.
- **Triggers, switches and collectibles react to any player**; their
  events' `by` names which one.
- **A save keeps the first player's place in `world.character`** and the
  others in `world.characters` (only when the schema keeps *Where the play
  stands*; see [saves](saves.md)).
- **Visual-script nodes drive the first controller** unless they have a
  player input.

Related: [input and rebinding](input.md), [cameras](cameras.md).
