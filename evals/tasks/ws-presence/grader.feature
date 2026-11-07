@eval @eval-ws-presence
Feature: Everyone in a room is told who joins and leaves

  Background:
    Given a fresh room

  Scenario: a join is announced to everyone, including the joiner
    When I open a websocket to the room as "a"
    Then within 5 seconds the websocket for "a" receives an event of type "presence"
    And that event's field "event" is "join"
    And that event's field "author" is "a"
    And that event's field "sockets" is 1
    When I open a websocket to the room as "b"
    Then within 5 seconds the websocket for "a" receives an event of type "presence"
    And that event's field "event" is "join"
    And that event's field "author" is "b"
    And that event's field "sockets" is 2
    And within 5 seconds the websocket for "b" receives an event of type "presence"
    And that event's field "sockets" is 2

  Scenario: a leave is announced to those who remain, with the right count
    When I open a websocket to the room as "a"
    And I open a websocket to the room as "b"
    Then within 5 seconds the websocket for "a" receives an event of type "presence"
    And within 5 seconds the websocket for "a" receives an event of type "presence"
    When I close the websocket for "b"
    Then within 5 seconds the websocket for "a" receives an event of type "presence"
    And that event's field "event" is "leave"
    And that event's field "author" is "b"
    And that event's field "sockets" is 1
    When I send a GET request to "/api/rooms/{room}"
    Then the response JSON field "sockets" is 1
