Feature: A room can describe itself
  The pull side of instrumentation. The logs say what happened; describe is the
  object's own answer to who it is, what it holds and what will wake it, at a
  cost that does not grow with the room. Asking is still a request: it wakes
  the object if it was asleep.

  Background:
    Given a fresh room

  Scenario: a room describes itself for the price of one row
    When I post 40 messages
    And I send a GET request to "/api/rooms/{room}/describe"
    Then the last response status is 200
    And the response JSON field "name" is the room's name
    And the response JSON field "max_seq" is 40
    And the response JSON array "tables" includes "messages"
    And the response JSON field "sockets" is 0
    # a post schedules the idle alarm, so there is a time the room will wake by itself
    And the response JSON field "alarm_at" is at least 1
    And the response JSON field "rows_read" is 1
