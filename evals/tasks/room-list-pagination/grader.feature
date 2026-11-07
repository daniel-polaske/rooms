@eval @eval-room-list-pagination
Feature: The room list pages with an opaque cursor

  Scenario: every room is listed exactly once when paging 2 at a time
    Given 5 fresh rooms with one message each
    And within 30 seconds the directory lists all of my rooms
    Then paging through the room list 2 at a time yields all of my rooms exactly once

  Scenario: a short page carries a cursor and a malformed cursor is rejected
    Given 3 fresh rooms with one message each
    And within 30 seconds the directory lists all of my rooms
    When I send a GET request to "/api/rooms?limit=2"
    Then the last response status is 200
    And the response JSON array has 2 items
    And the response header "x-next-cursor" is present
    When I send a GET request to "/api/rooms?limit=2&cursor=not-a-cursor"
    Then the last response status is 400
    And the response JSON field "error" is "bad cursor"
