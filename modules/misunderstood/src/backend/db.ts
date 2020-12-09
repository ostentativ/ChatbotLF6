import * as sdk from 'botpress/sdk'
import Knex from 'knex'
import _, { get, pick } from 'lodash'
import moment from 'moment'

import {
  DbFlaggedEvent,
  FlaggedEvent,
  FLAGGED_MESSAGE_STATUS,
  FLAGGED_MESSAGE_STATUSES,
  FLAG_REASON,
  ResolutionData,
  RESOLUTION_TYPE
} from '../types'

import applyChanges from './applyChanges'

const TABLE_NAME = 'misunderstood'
const EVENTS_TABLE_NAME = 'events'

export default class Db {
  knex: Knex & sdk.KnexExtension

  constructor(private bp: typeof sdk) {
    this.knex = bp.database
  }

  async initialize() {
    await this.knex.createTableIfNotExists(TABLE_NAME, table => {
      table.increments('id')
      table.string('eventId')
      table.string('botId')
      table.string('language')
      table.string('preview')
      table.enum('reason', Object.values(FLAG_REASON))
      table.enum('status', FLAGGED_MESSAGE_STATUSES).defaultTo(FLAGGED_MESSAGE_STATUS.new)
      table.enum('resolutionType', Object.values(RESOLUTION_TYPE))
      table.string('resolution')
      table.json('resolutionParams')
      table.timestamp('createdAt').defaultTo(this.knex.fn.now())
      table.timestamp('updatedAt').defaultTo(this.knex.fn.now())
    })
  }

  async addEvent(event: FlaggedEvent) {
    await this.knex(TABLE_NAME).insert(event)
  }

  async updateStatus(botId: string, id: string, status: FLAGGED_MESSAGE_STATUS, resolutionData?: ResolutionData) {
    if (status !== FLAGGED_MESSAGE_STATUS.pending) {
      resolutionData = { resolutionType: null, resolution: null, resolutionParams: null }
    } else {
      resolutionData = pick(resolutionData, 'resolutionType', 'resolution', 'resolutionParams')
    }

    await this.knex(TABLE_NAME)
      .where({ botId, id })
      .update({ status, ...resolutionData, updatedAt: this.knex.fn.now() })
  }

  async listEvents(
    botId: string,
    language: string,
    status: FLAGGED_MESSAGE_STATUS,
    options?: { startDate: Date; endDate: Date }
  ): Promise<DbFlaggedEvent[]> {
    const { startDate, endDate } = options || {}

    const query = this.knex(TABLE_NAME)
      .select('*')
      .where({ botId, language, status })

    if (startDate && endDate) {
      query.andWhere(this.knex.date.isBetween('updatedAt', startDate, endDate))
    }

    const data: DbFlaggedEvent[] = await query.orderBy('updatedAt', 'desc')

    return data.map((event: DbFlaggedEvent) => ({
      ...event,
      resolutionParams:
        event.resolutionParams && typeof event.resolutionParams !== 'object'
          ? JSON.parse(event.resolutionParams)
          : event.resolutionParams
    }))
  }

  async countEvents(botId: string, language: string, options?: { startDate: Date; endDate: Date }) {
    const { startDate, endDate } = options || {}

    const query = this.knex(TABLE_NAME)
      .where({ botId, language })
      .select('status')
      .count({ count: 'id' })

    if (startDate && endDate) {
      query.andWhere(this.knex.date.isBetween('updatedAt', startDate, endDate))
    }

    const data: { status: string; count: number }[] = await query.groupBy('status')

    return data.reduce((acc, row) => {
      acc[row.status] = Number(row.count)
      return acc
    }, {})
  }

  async getEventDetails(botId: string, id: string) {
    const event = await this.knex(TABLE_NAME)
      .where({ botId, id })
      .limit(1)
      .select('*')
      .then((data: DbFlaggedEvent[]) => (data && data.length ? data[0] : null))

    const parentEvent = await this.knex(EVENTS_TABLE_NAME)
      .where({ botId, incomingEventId: event.eventId, direction: 'incoming' })
      .select('id', 'threadId', 'sessionId', 'event', 'createdOn')
      .limit(1)
      .first()

    if (!parentEvent) {
      return
    }

    const { threadId, sessionId, id: messageId, event: eventDetails, createdOn: messageCreatedOn } = parentEvent

    // SQLite will return dates as strings.
    // Since this.knex.date.[isAfter() | isBeforeOrOn()] expect strings to be colum names,
    // I wrap the timestamp string to a Date
    const messageCreatedOnAsDate = moment(messageCreatedOn).toDate()

    const [messagesBefore, messagesAfter] = await Promise.all([
      this.knex(EVENTS_TABLE_NAME)
        .where({ botId, threadId, sessionId })
        .andWhere(this.knex.date.isBeforeOrOn('createdOn', messageCreatedOnAsDate))
        // Two events with different id can have same createdOn
        .orderBy([
          { column: 'createdOn', order: 'desc' },
          { column: 'id', order: 'desc' }
        ])
        .limit(6) // More messages displayed before can help user understand conversation better
        .select('id', 'event', 'createdOn'),
      this.knex(EVENTS_TABLE_NAME)
        .where({ botId, threadId, sessionId })
        .andWhere(this.knex.date.isAfter('createdOn', messageCreatedOnAsDate))
        .orderBy(['createdOn', 'id'])
        .limit(3)
        .select('id', 'event', 'createdOn')
    ])

    const context = _.chain([...messagesBefore, ...messagesAfter])
      .sortBy(['createdOn', 'id'])
      .map(({ id, event }) => {
        const eventObj = typeof event === 'string' ? JSON.parse(event) : event
        return {
          direction: eventObj.direction,
          preview: (eventObj.preview || '').replace(/<[^>]*>?/gm, ''),
          payloadMessage: get(eventObj, 'payload.message'),
          isCurrent: id === messageId
        }
      })
      .value()

    const parsedEventDetails =
      eventDetails && typeof eventDetails !== 'object' ? JSON.parse(eventDetails) : eventDetails

    return {
      ...event,
      resolutionParams:
        event.resolutionParams && typeof event.resolutionParams !== 'object'
          ? JSON.parse(event.resolutionParams)
          : event.resolutionParams,
      context,
      nluContexts: (parsedEventDetails && parsedEventDetails.nlu && parsedEventDetails.nlu.includedContexts) || []
    }
  }

  applyChanges(botId: string) {
    return applyChanges(this.bp, botId, TABLE_NAME)
  }
}
