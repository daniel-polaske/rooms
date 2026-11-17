Feature: A room can say what it is
  Know thyself, for a Durable Object. An operator asks a room to describe itself:
  who it is, which life this is, what it owns and what is scheduled. The answer
  comes from inside the object, and asking costs the same however large the room is.

  Background:
    Given a fresh room

  Scenario: describing a room needs the shared secret
    When I send a GET request to "/api/rooms/{room}/describe"
    Then the last response status is 403

  Scenario: a room knows its identity, its storage and its timer
    When I post 3 messages
    And I describe the room
    Then the last response status is 200
    And the response JSON field "class" is "RoomDO"
    And the description names the room as it was addressed
    And the description has a 64-digit id and an 8-digit incarnation
    And the response JSON field "max_seq" is at least 3
    And the response JSON field "sockets" is 0
    And the description lists the tables "messages" and "meta"
    And the description has an alarm in the future

  Scenario: asking costs the same however large the room is
    When I post 2 messages as "early"
    And I describe the room
    And I post 40 messages as "late"
    And I describe the room
    Then both descriptions cost the same rows read

  Scenario: a reset changes the incarnation and nothing else about who the room is
    When I post a message with msg_id "keep" and body "durable"
    And I describe the room
    And I kill the room
    And I describe the room
    Then both descriptions have the same id, name and max_seq
    And the two descriptions have different incarnations
