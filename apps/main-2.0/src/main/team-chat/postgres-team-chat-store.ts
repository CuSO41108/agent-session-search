import type { PostgresDatabase, PostgresQueryable } from "../../core/postgres/database";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomSummary,
  TeamChatWorkspaceReservation,
} from "../../shared/team-chat";
import type {
  TeamChatAgentSession,
  TeamChatAttemptEvent,
  TeamChatContextPage,
  TeamChatDispatchUpdate,
  TeamChatExecutionAttempt,
  TeamChatExecutionAttemptUpdate,
  TeamChatInboxItem,
  TeamChatMessageRange,
  TeamChatPendingActivation,
  TeamChatPersistedActivations,
  TeamChatRoomTurn,
  TeamChatStore,
  TeamChatTask,
  TeamChatTaskFinish,
} from "./team-chat-store";

const MESSAGE_COLUMNS = `id, room_id, sequence, sender_type, sender_agent_id,
  recipient_member_id, sender_name, content, delivery_type, root_message_id,
  source_message_id, hop, status, based_on_sequence, created_at, updated_at`;

const DISPATCH_COLUMNS = `id, room_id, mention_id, task_id, root_message_id,
  source_message_id, target_agent_id, room_snapshot_sequence, hop, status,
  error, started_at, finished_at, created_at, updated_at`;

export class PostgresTeamChatStore implements TeamChatStore {
  constructor(private readonly database: PostgresDatabase) {}

  async initialize(): Promise<void> {
    try {
      await this.database.transaction(async (transaction) => {
        await transaction.query(`UPDATE agent_recall.chat_dispatch_attempts
          SET status = 'interrupted', finished_at = NOW()
          WHERE status = 'running'`);
        await transaction.query(`UPDATE agent_recall.chat_dispatches
          SET status = 'interrupted', finished_at = NOW(), updated_at = NOW()
          WHERE status = 'running'`);
      });
    } catch (error) {
      throw postgresConnectionError(error);
    }
  }

  async close(): Promise<void> {
    // The application owns the shared PostgreSQL connection pool.
  }

  async createRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO agent_recall.chat_rooms
          (id, name, work_dir, archived, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [room.id, room.name, room.workDir, room.archived, room.createdAt, room.updatedAt],
      );
      for (const agent of room.agents) {
        await this.insertRoomAgent(transaction, agent);
      }
    });
    return room;
  }

  async listRooms(): Promise<TeamChatRoomSummary[]> {
    const result = await this.database.query<RoomSummaryRow>(
      `SELECT r.id, r.name, r.work_dir, r.archived, r.created_at, r.updated_at,
              COUNT(a.agent_id)::integer AS agent_count,
              latest.content AS last_message,
              latest.created_at AS last_message_at
       FROM agent_recall.chat_rooms r
       LEFT JOIN agent_recall.chat_room_agents a ON a.room_id = r.id AND a.enabled = true
       LEFT JOIN LATERAL (
         SELECT content, created_at
         FROM agent_recall.chat_messages
         WHERE room_id = r.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest ON true
       WHERE r.archived = false
       GROUP BY r.id, latest.content, latest.created_at
       ORDER BY COALESCE(latest.created_at, r.updated_at) DESC, r.id DESC`,
    );
    return result.rows.map(mapRoomSummaryRow);
  }

  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    const roomResult = await this.database.query<RoomRow>(
      `SELECT id, name, work_dir, archived, created_at, updated_at
       FROM agent_recall.chat_rooms
       WHERE id = $1`,
      [roomId],
    );
    const row = roomResult.rows[0];
    if (!row) return undefined;
    const agentResult = await this.database.query<RoomAgentRow>(
      `SELECT room_id, agent_id, configured_agent_id, display_name, runtime_id,
              channel_id, model_id, enabled, position, joined_at
       FROM agent_recall.chat_room_agents
       WHERE room_id = $1
       ORDER BY position, agent_id`,
      [roomId],
    );
    return {
      id: String(row.id),
      name: String(row.name),
      workDir: String(row.work_dir),
      archived: Boolean(row.archived),
      agents: agentResult.rows.map(mapRoomAgentRow),
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  async updateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE agent_recall.chat_rooms
         SET name = $2, work_dir = $3, archived = $4, updated_at = $5
         WHERE id = $1`,
        [room.id, room.name, room.workDir, room.archived, room.updatedAt],
      );
      await transaction.query("DELETE FROM agent_recall.chat_room_agents WHERE room_id = $1", [room.id]);
      for (const agent of room.agents) await this.insertRoomAgent(transaction, agent);
      await transaction.query(
        `DELETE FROM agent_recall.chat_agent_sessions
         WHERE room_id = $1 AND NOT (agent_id = ANY($2::text[]))`,
        [room.id, room.agents.map((agent) => agent.agentId)],
      );
    });
    return room;
  }

  async archiveRoom(roomId: string, updatedAt: string): Promise<void> {
    await this.database.query(
      "UPDATE agent_recall.chat_rooms SET archived = true, updated_at = $2 WHERE id = $1",
      [roomId, updatedAt],
    );
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM agent_recall.chat_rooms WHERE id = $1",
      [roomId],
    );
    return result.rowCount > 0;
  }

  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    const limit = request.limit ?? 100;
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1
         AND ($2::uuid IS NULL OR sequence < (
           SELECT sequence FROM agent_recall.chat_messages WHERE room_id = $1 AND id = $2::uuid
         ))
       ORDER BY sequence DESC
       LIMIT $3`,
      [request.roomId, request.before ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const selected = result.rows.slice(0, limit);
    return {
      messages: selected.map(mapMessageRow).reverse(),
      ...(hasMore && selected.length > 0 ? { nextBefore: String(selected.at(-1)!.id) } : {}),
    };
  }

  async getLatestMessageSequence(roomId: string): Promise<number> {
    const result = await this.database.query<{ sequence: unknown }>(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence
       FROM agent_recall.chat_messages
       WHERE room_id = $1`,
      [roomId],
    );
    return Number(result.rows[0]?.sequence ?? 0);
  }

  async listRoomContext(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): Promise<TeamChatContextPage> {
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1
         AND sequence > $2
         AND sequence <= $3
       ORDER BY sequence DESC
       LIMIT $4`,
      [roomId, afterSequence, throughSequence, limit + 1],
    );
    const truncated = result.rows.length > limit;
    const messages = result.rows.slice(0, limit).map(mapMessageRow).reverse();
    const firstSequence = messages[0]?.sequence;
    return {
      messages,
      truncated,
      snapshotSequence: throughSequence,
      ...(truncated && firstSequence !== undefined && firstSequence > afterSequence + 1
        ? {
            omittedSequenceRange: {
              from: afterSequence + 1,
              to: firstSequence - 1,
            },
          }
        : {}),
    };
  }

  async getMessages(roomId: string, messageIds: string[]): Promise<TeamChatMessage[]> {
    if (messageIds.length === 0) return [];
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1 AND id = ANY($2::uuid[])
       ORDER BY sequence`,
      [roomId, messageIds],
    );
    return result.rows.map(mapMessageRow);
  }

  async readMessageRange(roomId: string, range: TeamChatMessageRange): Promise<TeamChatMessage[]> {
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1
         AND ($2::bigint IS NULL OR sequence > $2::bigint)
         AND ($3::bigint IS NULL OR sequence < $3::bigint)
       ORDER BY sequence
       LIMIT $4`,
      [roomId, range.after ?? null, range.before ?? null, range.limit],
    );
    return result.rows.map(mapMessageRow);
  }

  async searchMessages(roomId: string, query: string, limit: number): Promise<TeamChatMessage[]> {
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1 AND content ILIKE $2
       ORDER BY sequence DESC
       LIMIT $3`,
      [roomId, `%${query}%`, limit],
    );
    return result.rows.map(mapMessageRow).reverse();
  }

  async insertMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    return (await this.insertMessageWithActivations(message, [])).message;
  }

  async insertMessageWithActivations(
    message: TeamChatMessage,
    activations: TeamChatPendingActivation[],
  ): Promise<TeamChatPersistedActivations> {
    let sequence = 0;
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        "SELECT id FROM agent_recall.chat_rooms WHERE id = $1 FOR UPDATE",
        [message.roomId],
      );
      const sequenceResult = await transaction.query<{ next_sequence: unknown }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM agent_recall.chat_messages
         WHERE room_id = $1`,
        [message.roomId],
      );
      sequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
      await this.insertMessageRow(transaction, { ...message, sequence });
      for (const activation of activations) {
        await transaction.query(
          `INSERT INTO agent_recall.chat_message_mentions
            (id, room_id, message_id, member_id, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            activation.mention.id,
            activation.mention.roomId,
            activation.mention.messageId,
            activation.mention.memberId,
            activation.mention.createdAt,
          ],
        );
        await transaction.query(
          `INSERT INTO agent_recall.chat_tasks
            (id, room_id, member_id, root_message_id, status, summary, evidence,
             created_at, updated_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            activation.task.id,
            activation.task.roomId,
            activation.task.memberId,
            activation.task.rootMessageId,
            activation.task.status,
            activation.task.summary ?? null,
            JSON.stringify(activation.task.evidence),
            activation.task.createdAt,
            activation.task.updatedAt,
            activation.task.finishedAt ?? null,
          ],
        );
        await this.insertDispatchRow(transaction, {
          ...activation.dispatch,
          roomSnapshotSequence: sequence,
        });
      }
      await transaction.query(
        "UPDATE agent_recall.chat_rooms SET updated_at = $2 WHERE id = $1",
        [message.roomId, message.updatedAt],
      );
    });
    return {
      message: { ...message, sequence },
      activations: activations.map((activation) => ({
        mention: { ...activation.mention },
        task: { ...activation.task, evidence: [...activation.task.evidence] },
        dispatch: { ...activation.dispatch, roomSnapshotSequence: sequence },
      })),
    };
  }

  async insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch> {
    await this.insertDispatchRow(this.database, dispatch);
    return dispatch;
  }

  async listQueuedDispatches(): Promise<TeamChatDispatch[]> {
    const result = await this.database.query<DispatchRow>(
      `SELECT ${DISPATCH_COLUMNS}
       FROM agent_recall.chat_dispatches
       WHERE status = 'queued'
       ORDER BY room_id, target_agent_id, room_snapshot_sequence, created_at, id`,
    );
    return result.rows.map(mapDispatchRow);
  }

  async listInbox(
    roomId: string,
    memberId: string,
    status: TeamChatDispatch["status"] | undefined,
    limit: number,
  ): Promise<TeamChatInboxItem[]> {
    const result = await this.database.query<InboxRow>(
      `SELECT
         mentions.id AS mention_id,
         mentions.message_id,
         dispatches.task_id,
         dispatches.id AS turn_id,
         mentions.member_id,
         messages.sequence,
         messages.content,
         dispatches.status,
         mentions.created_at,
         dispatches.updated_at
       FROM agent_recall.chat_message_mentions AS mentions
       JOIN agent_recall.chat_messages AS messages
         ON messages.id = mentions.message_id AND messages.room_id = mentions.room_id
       JOIN agent_recall.chat_dispatches AS dispatches
         ON dispatches.mention_id = mentions.id AND dispatches.room_id = mentions.room_id
       WHERE mentions.room_id = $1
         AND mentions.member_id = $2
         AND ($3::varchar IS NULL OR dispatches.status = $3)
       ORDER BY messages.sequence DESC
       LIMIT $4`,
      [roomId, memberId, status ?? null, limit],
    );
    return result.rows.map(mapInboxRow);
  }

  async insertExecutionAttempt(attempt: TeamChatExecutionAttempt): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_recall.chat_dispatch_attempts
        (id, dispatch_id, attempt_number, runtime_id, runtime_session_ref,
         native_turn_id, room_snapshot_sequence, room_sequence_at_finish, status,
         error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        attempt.id,
        attempt.dispatchId,
        attempt.attemptNumber,
        attempt.runtimeId,
        attempt.runtimeSessionRef ?? null,
        attempt.nativeTurnId ?? null,
        attempt.roomSnapshotSequence,
        attempt.roomSequenceAtFinish ?? null,
        attempt.status,
        attempt.error ?? null,
        attempt.startedAt,
        attempt.finishedAt ?? null,
      ],
    );
  }

  async updateExecutionAttempt(
    attemptId: string,
    patch: TeamChatExecutionAttemptUpdate,
  ): Promise<void> {
    await this.database.query(
      `UPDATE agent_recall.chat_dispatch_attempts
       SET status = $2,
           runtime_session_ref = $3,
           native_turn_id = $4,
           room_sequence_at_finish = $5,
           error = $6,
           finished_at = $7
       WHERE id = $1`,
      [
        attemptId,
        patch.status,
        patch.runtimeSessionRef ?? null,
        patch.nativeTurnId ?? null,
        patch.roomSequenceAtFinish ?? null,
        patch.error ?? null,
        patch.finishedAt ?? null,
      ],
    );
  }

  async listExecutionAttempts(dispatchId: string): Promise<TeamChatExecutionAttempt[]> {
    const result = await this.database.query<ExecutionAttemptRow>(
      `SELECT id, dispatch_id, attempt_number, runtime_id, runtime_session_ref,
              native_turn_id, room_snapshot_sequence, room_sequence_at_finish,
              status, error, started_at, finished_at
       FROM agent_recall.chat_dispatch_attempts
       WHERE dispatch_id = $1
       ORDER BY attempt_number`,
      [dispatchId],
    );
    return result.rows.map(mapExecutionAttemptRow);
  }

  async insertAttemptEvent(event: TeamChatAttemptEvent): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_recall.chat_attempt_events
        (id, attempt_id, sequence, type, name, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.id,
        event.attemptId,
        event.sequence,
        event.type,
        event.name ?? null,
        event.content,
        event.createdAt,
      ],
    );
  }

  async listTurnEvents(
    roomId: string,
    dispatchId: string,
    limit: number,
  ): Promise<TeamChatAttemptEvent[]> {
    const result = await this.database.query<AttemptEventRow>(
      `SELECT events.id, events.attempt_id, events.sequence, events.type,
              events.name, events.content, events.created_at
       FROM agent_recall.chat_attempt_events AS events
       JOIN agent_recall.chat_dispatch_attempts AS attempts
         ON attempts.id = events.attempt_id
       JOIN agent_recall.chat_dispatches AS dispatches
         ON dispatches.id = attempts.dispatch_id
       WHERE dispatches.room_id = $1 AND dispatches.id = $2
       ORDER BY attempts.attempt_number, events.sequence
       LIMIT $3`,
      [roomId, dispatchId, limit],
    );
    return result.rows.map(mapAttemptEventRow);
  }

  async listRoomTurns(roomId: string, limit: number): Promise<TeamChatRoomTurn[]> {
    const result = await this.database.query<DispatchRow>(
      `SELECT ${DISPATCH_COLUMNS}
       FROM agent_recall.chat_dispatches
       WHERE room_id = $1
       ORDER BY room_snapshot_sequence DESC, created_at DESC, id DESC
       LIMIT $2`,
      [roomId, limit],
    );
    return Promise.all(result.rows.map((row) => this.hydrateRoomTurn(mapDispatchRow(row))));
  }

  async getRoomTurn(
    roomId: string,
    dispatchId: string,
  ): Promise<TeamChatRoomTurn | undefined> {
    const result = await this.database.query<DispatchRow>(
      `SELECT ${DISPATCH_COLUMNS}
       FROM agent_recall.chat_dispatches
       WHERE room_id = $1 AND id = $2`,
      [roomId, dispatchId],
    );
    const row = result.rows[0];
    return row ? this.hydrateRoomTurn(mapDispatchRow(row)) : undefined;
  }

  async listThreadMessages(
    roomId: string,
    rootMessageId: string,
    limit: number,
  ): Promise<TeamChatMessage[]> {
    const result = await this.database.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM agent_recall.chat_messages
       WHERE room_id = $1 AND root_message_id = $2
       ORDER BY sequence
       LIMIT $3`,
      [roomId, rootMessageId, limit],
    );
    return result.rows.map(mapMessageRow);
  }

  async finishTask(
    roomId: string,
    memberId: string,
    taskId: string,
    finish: TeamChatTaskFinish,
  ): Promise<TeamChatTask | undefined> {
    let task: TeamChatTask | undefined;
    await this.database.transaction(async (transaction) => {
      const currentResult = await transaction.query<TaskRow>(
        `SELECT id, room_id, member_id, root_message_id, status, summary, evidence,
                created_at, updated_at, finished_at
         FROM agent_recall.chat_tasks
         WHERE room_id = $1 AND member_id = $2 AND id = $3
         FOR UPDATE`,
        [roomId, memberId, taskId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) return;
      const current = mapTaskRow(currentRow);
      if (current.status !== "in_progress") {
        if (
          current.status !== finish.status ||
          current.summary !== finish.summary ||
          JSON.stringify(current.evidence) !== JSON.stringify(finish.evidence)
        ) {
          throw new Error("The Studio Task is already finished with a different result.");
        }
        task = current;
        return;
      }
      const updated = await transaction.query<TaskRow>(
        `UPDATE agent_recall.chat_tasks
         SET status = $4, summary = $5, evidence = $6::jsonb,
             updated_at = $7, finished_at = $7
         WHERE room_id = $1 AND member_id = $2 AND id = $3
         RETURNING id, room_id, member_id, root_message_id, status, summary,
                   evidence, created_at, updated_at, finished_at`,
        [
          roomId,
          memberId,
          taskId,
          finish.status,
          finish.summary,
          JSON.stringify(finish.evidence),
          finish.finishedAt,
        ],
      );
      task = mapTaskRow(updated.rows[0]!);
    });
    return task;
  }

  async updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void> {
    await this.database.query(
      `UPDATE agent_recall.chat_dispatches
       SET status = $2, error = $3, started_at = $4, finished_at = $5, updated_at = $6
       WHERE id = $1`,
      [
        dispatchId,
        patch.status,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        patch.updatedAt,
      ],
    );
  }

  async markRunningDispatchesInterrupted(updatedAt: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE agent_recall.chat_dispatch_attempts
         SET status = 'interrupted', finished_at = $1
         WHERE status = 'running'`,
        [updatedAt],
      );
      await transaction.query(
        `UPDATE agent_recall.chat_dispatches
         SET status = 'interrupted', finished_at = $1, updated_at = $1
         WHERE status = 'running'`,
        [updatedAt],
      );
    });
  }

  async listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]> {
    const result = await this.database.query<AgentSessionRow>(
      `SELECT room_id, agent_id, runtime_id, channel_id, model_id,
              runtime_conversation, last_context_message_id,
              room_context_sequence, updated_at
       FROM agent_recall.chat_agent_sessions
       WHERE room_id = $1
       ORDER BY agent_id`,
      [roomId],
    );
    return result.rows.map(mapAgentSessionRow);
  }

  async upsertAgentSession(session: TeamChatAgentSession): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_recall.chat_agent_sessions
        (room_id, agent_id, runtime_id, channel_id, model_id,
         runtime_conversation, last_context_message_id, room_context_sequence, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET
         runtime_id = EXCLUDED.runtime_id,
         channel_id = EXCLUDED.channel_id,
         model_id = EXCLUDED.model_id,
         runtime_conversation = EXCLUDED.runtime_conversation,
         last_context_message_id = EXCLUDED.last_context_message_id,
         room_context_sequence = EXCLUDED.room_context_sequence,
         updated_at = EXCLUDED.updated_at`,
      [
        session.roomId,
        session.agentId,
        session.runtimeId,
        session.channelId,
        session.modelId,
        JSON.stringify(session.runtimeConversation),
        session.lastContextMessageId ?? null,
        session.roomContextSequence,
        session.updatedAt,
      ],
    );
  }

  async deleteAgentSession(roomId: string, agentId: string): Promise<void> {
    await this.database.query(
      "DELETE FROM agent_recall.chat_agent_sessions WHERE room_id = $1 AND agent_id = $2",
      [roomId, agentId],
    );
  }

  async listWorkspaceReservations(
    roomId: string,
    relativePaths?: string[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    await this.database.query(
      "DELETE FROM agent_recall.chat_workspace_reservations WHERE expires_at <= NOW()",
    );
    if (relativePaths && relativePaths.length === 0) return [];
    const result = await this.database.query<WorkspaceReservationRow>(
      `SELECT room_id, member_id, relative_path, reason, expires_at, created_at, updated_at
       FROM agent_recall.chat_workspace_reservations
       WHERE room_id = $1
         AND ($2::text[] IS NULL OR relative_path = ANY($2::text[]))
       ORDER BY relative_path`,
      [roomId, relativePaths ?? null],
    );
    return result.rows.map(mapWorkspaceReservationRow);
  }

  async reserveWorkspacePaths(
    reservations: TeamChatWorkspaceReservation[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    if (reservations.length === 0) return [];
    await this.database.transaction(async (transaction) => {
      for (const reservation of reservations) {
        await transaction.query(
          `INSERT INTO agent_recall.chat_workspace_reservations
            (room_id, member_id, relative_path, reason, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (room_id, relative_path) DO UPDATE SET
             member_id = EXCLUDED.member_id,
             reason = EXCLUDED.reason,
             expires_at = EXCLUDED.expires_at,
             updated_at = EXCLUDED.updated_at`,
          [
            reservation.roomId,
            reservation.memberId,
            reservation.relativePath,
            reservation.reason ?? null,
            reservation.expiresAt,
            reservation.createdAt,
            reservation.updatedAt,
          ],
        );
      }
    });
    return reservations.map((reservation) => ({ ...reservation }));
  }

  async releaseWorkspacePaths(
    roomId: string,
    memberId: string,
    relativePaths: string[],
  ): Promise<number> {
    if (relativePaths.length === 0) return 0;
    const result = await this.database.query(
      `DELETE FROM agent_recall.chat_workspace_reservations
       WHERE room_id = $1 AND member_id = $2 AND relative_path = ANY($3::text[])`,
      [roomId, memberId, relativePaths],
    );
    return result.rowCount;
  }

  private async insertMessageRow(
    database: PostgresQueryable,
    message: TeamChatMessage,
  ): Promise<void> {
    await database.query(
      `INSERT INTO agent_recall.chat_messages
        (id, room_id, sequence, sender_type, sender_agent_id, recipient_member_id,
         sender_name, content, delivery_type, root_message_id, source_message_id,
         hop, status, based_on_sequence, created_at, updated_at)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )`,
      [
        message.id,
        message.roomId,
        message.sequence,
        message.senderType,
        message.senderAgentId ?? null,
        message.recipientMemberId ?? null,
        message.senderName,
        message.content,
        message.deliveryType,
        message.rootMessageId,
        message.sourceMessageId ?? null,
        message.hop,
        message.status,
        message.basedOnSequence ?? null,
        message.createdAt,
        message.updatedAt,
      ],
    );
  }

  private async insertDispatchRow(
    database: PostgresQueryable,
    dispatch: TeamChatDispatch,
  ): Promise<void> {
    await database.query(
      `INSERT INTO agent_recall.chat_dispatches
        (id, room_id, mention_id, task_id, root_message_id, source_message_id,
         target_agent_id, room_snapshot_sequence, hop, status, error, started_at,
         finished_at, created_at, updated_at)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       )`,
      [
        dispatch.id,
        dispatch.roomId,
        dispatch.mentionId ?? null,
        dispatch.taskId ?? null,
        dispatch.rootMessageId,
        dispatch.sourceMessageId,
        dispatch.targetAgentId,
        dispatch.roomSnapshotSequence ?? null,
        dispatch.hop,
        dispatch.status,
        dispatch.error ?? null,
        dispatch.startedAt ?? null,
        dispatch.finishedAt ?? null,
        dispatch.createdAt,
        dispatch.updatedAt,
      ],
    );
  }

  private async insertRoomAgent(database: PostgresQueryable, agent: TeamChatRoomAgent): Promise<void> {
    await database.query(
      `INSERT INTO agent_recall.chat_room_agents
        (room_id, agent_id, configured_agent_id, display_name, runtime_id, channel_id,
         model_id, enabled, position, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        agent.roomId,
        agent.agentId,
        agent.configuredAgentId,
        agent.displayName,
        agent.runtimeId,
        agent.channelId,
        agent.modelId,
        agent.enabled,
        agent.position,
        agent.joinedAt,
      ],
    );
  }

  private async hydrateRoomTurn(dispatch: TeamChatDispatch): Promise<TeamChatRoomTurn> {
    const [taskResult, replyResult, triggerMessages] = await Promise.all([
      dispatch.taskId
        ? this.database.query<TaskRow>(
            `SELECT id, room_id, member_id, root_message_id, status, summary, evidence,
                    created_at, updated_at, finished_at
             FROM agent_recall.chat_tasks
             WHERE room_id = $1 AND id = $2`,
            [dispatch.roomId, dispatch.taskId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      this.database.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM agent_recall.chat_messages
         WHERE room_id = $1
           AND root_message_id = $2
           AND source_message_id = $3
           AND sender_agent_id = $4
           AND delivery_type = 'reply'
         ORDER BY sequence DESC
         LIMIT 1`,
        [
          dispatch.roomId,
          dispatch.rootMessageId,
          dispatch.sourceMessageId,
          dispatch.targetAgentId,
        ],
      ),
      this.getMessages(dispatch.roomId, [dispatch.sourceMessageId]),
    ]);
    const triggerMessage = triggerMessages[0];
    if (!triggerMessage) throw new Error("Stored Studio Turn trigger is unavailable.");
    const taskRow = taskResult.rows[0] as TaskRow | undefined;
    const replyRow = replyResult.rows[0];
    return {
      dispatch,
      ...(taskRow ? { task: mapTaskRow(taskRow) } : {}),
      triggerMessage,
      ...(replyRow ? { replyMessage: mapMessageRow(replyRow) } : {}),
    };
  }
}

type RoomRow = Record<string, unknown> & {
  id: unknown;
  name: unknown;
  work_dir: unknown;
  archived: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type RoomSummaryRow = RoomRow & {
  agent_count: unknown;
  last_message: unknown;
  last_message_at: unknown;
};

type RoomAgentRow = Record<string, unknown> & {
  room_id: unknown;
  agent_id: unknown;
  configured_agent_id: unknown;
  display_name: unknown;
  runtime_id: unknown;
  channel_id: unknown;
  model_id: unknown;
  enabled: unknown;
  position: unknown;
  joined_at: unknown;
};

type MessageRow = Record<string, unknown> & {
  id: unknown;
  room_id: unknown;
  sequence: unknown;
  sender_type: unknown;
  sender_agent_id: unknown;
  recipient_member_id: unknown;
  sender_name: unknown;
  content: unknown;
  delivery_type: unknown;
  root_message_id: unknown;
  source_message_id: unknown;
  hop: unknown;
  status: unknown;
  based_on_sequence: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type DispatchRow = Record<string, unknown> & {
  id: unknown;
  room_id: unknown;
  mention_id: unknown;
  task_id: unknown;
  root_message_id: unknown;
  source_message_id: unknown;
  target_agent_id: unknown;
  room_snapshot_sequence: unknown;
  hop: unknown;
  status: unknown;
  error: unknown;
  started_at: unknown;
  finished_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type InboxRow = Record<string, unknown> & {
  mention_id: unknown;
  message_id: unknown;
  task_id: unknown;
  turn_id: unknown;
  member_id: unknown;
  sequence: unknown;
  content: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ExecutionAttemptRow = Record<string, unknown> & {
  id: unknown;
  dispatch_id: unknown;
  attempt_number: unknown;
  runtime_id: unknown;
  runtime_session_ref: unknown;
  native_turn_id: unknown;
  room_snapshot_sequence: unknown;
  room_sequence_at_finish: unknown;
  status: unknown;
  error: unknown;
  started_at: unknown;
  finished_at: unknown;
};

type AttemptEventRow = Record<string, unknown> & {
  id: unknown;
  attempt_id: unknown;
  sequence: unknown;
  type: unknown;
  name: unknown;
  content: unknown;
  created_at: unknown;
};

type TaskRow = Record<string, unknown> & {
  id: unknown;
  room_id: unknown;
  member_id: unknown;
  root_message_id: unknown;
  status: unknown;
  summary: unknown;
  evidence: unknown;
  created_at: unknown;
  updated_at: unknown;
  finished_at: unknown;
};

type AgentSessionRow = Record<string, unknown> & {
  room_id: unknown;
  agent_id: unknown;
  runtime_id: unknown;
  channel_id: unknown;
  model_id: unknown;
  runtime_conversation: unknown;
  last_context_message_id: unknown;
  room_context_sequence: unknown;
  updated_at: unknown;
};

type WorkspaceReservationRow = Record<string, unknown> & {
  room_id: unknown;
  member_id: unknown;
  relative_path: unknown;
  reason: unknown;
  expires_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function mapRoomSummaryRow(row: RoomSummaryRow): TeamChatRoomSummary {
  const lastMessage = nullableString(row.last_message);
  const lastMessageAt = row.last_message_at === null || row.last_message_at === undefined
    ? undefined
    : toIsoString(row.last_message_at);
  return {
    id: String(row.id),
    name: String(row.name),
    workDir: String(row.work_dir),
    archived: Boolean(row.archived),
    agentCount: Number(row.agent_count),
    ...(lastMessage ? { lastMessage } : {}),
    ...(lastMessageAt ? { lastMessageAt } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRoomAgentRow(row: RoomAgentRow): TeamChatRoomAgent {
  return {
    roomId: String(row.room_id),
    agentId: String(row.agent_id),
    configuredAgentId: String(row.configured_agent_id),
    displayName: String(row.display_name),
    runtimeId: String(row.runtime_id),
    channelId: String(row.channel_id),
    modelId: String(row.model_id),
    enabled: Boolean(row.enabled),
    position: Number(row.position),
    joinedAt: toIsoString(row.joined_at),
    continuationAvailable: false,
    hasActiveConversation: false,
  };
}

function mapMessageRow(row: MessageRow): TeamChatMessage {
  const senderAgentId = nullableString(row.sender_agent_id);
  const recipientMemberId = nullableString(row.recipient_member_id);
  const sourceMessageId = nullableString(row.source_message_id);
  const basedOnSequence = nullableNumber(row.based_on_sequence);
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    sequence: Number(row.sequence),
    senderType: row.sender_type as TeamChatMessage["senderType"],
    ...(senderAgentId ? { senderAgentId } : {}),
    ...(recipientMemberId ? { recipientMemberId } : {}),
    senderName: String(row.sender_name),
    content: String(row.content),
    deliveryType: row.delivery_type as TeamChatMessage["deliveryType"],
    rootMessageId: String(row.root_message_id),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    hop: Number(row.hop),
    status: row.status as TeamChatMessage["status"],
    ...(basedOnSequence === undefined ? {} : { basedOnSequence }),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapDispatchRow(row: DispatchRow): TeamChatDispatch {
  const mentionId = nullableString(row.mention_id);
  const taskId = nullableString(row.task_id);
  const roomSnapshotSequence = nullableNumber(row.room_snapshot_sequence);
  const error = nullableString(row.error);
  const startedAt = nullableDate(row.started_at);
  const finishedAt = nullableDate(row.finished_at);
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    ...(mentionId ? { mentionId } : {}),
    ...(taskId ? { taskId } : {}),
    rootMessageId: String(row.root_message_id),
    sourceMessageId: String(row.source_message_id),
    targetAgentId: String(row.target_agent_id),
    ...(roomSnapshotSequence === undefined ? {} : { roomSnapshotSequence }),
    hop: Number(row.hop),
    status: row.status as TeamChatDispatch["status"],
    ...(error ? { error } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapInboxRow(row: InboxRow): TeamChatInboxItem {
  return {
    mentionId: String(row.mention_id),
    messageId: String(row.message_id),
    taskId: String(row.task_id),
    turnId: String(row.turn_id),
    memberId: String(row.member_id),
    sequence: Number(row.sequence),
    content: String(row.content),
    status: row.status as TeamChatDispatch["status"],
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapExecutionAttemptRow(row: ExecutionAttemptRow): TeamChatExecutionAttempt {
  const runtimeSessionRef = nullableString(row.runtime_session_ref);
  const nativeTurnId = nullableString(row.native_turn_id);
  const roomSequenceAtFinish = nullableNumber(row.room_sequence_at_finish);
  const error = nullableString(row.error);
  const finishedAt = nullableDate(row.finished_at);
  return {
    id: String(row.id),
    dispatchId: String(row.dispatch_id),
    attemptNumber: Number(row.attempt_number),
    runtimeId: String(row.runtime_id),
    ...(runtimeSessionRef ? { runtimeSessionRef } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    roomSnapshotSequence: Number(row.room_snapshot_sequence),
    ...(roomSequenceAtFinish === undefined ? {} : { roomSequenceAtFinish }),
    status: row.status as TeamChatExecutionAttempt["status"],
    ...(error ? { error } : {}),
    startedAt: toIsoString(row.started_at),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

function mapAttemptEventRow(row: AttemptEventRow): TeamChatAttemptEvent {
  const name = nullableString(row.name);
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    sequence: Number(row.sequence),
    type: row.type as TeamChatAttemptEvent["type"],
    ...(name ? { name } : {}),
    content: String(row.content),
    createdAt: toIsoString(row.created_at),
  };
}

function mapTaskRow(row: TaskRow): TeamChatTask {
  const summary = nullableString(row.summary);
  const finishedAt = nullableDate(row.finished_at);
  const evidenceValue = typeof row.evidence === "string"
    ? JSON.parse(row.evidence) as unknown
    : row.evidence;
  const evidence = Array.isArray(evidenceValue)
    ? evidenceValue.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    memberId: String(row.member_id),
    rootMessageId: String(row.root_message_id),
    status: row.status as TeamChatTask["status"],
    ...(summary ? { summary } : {}),
    evidence,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

function mapAgentSessionRow(row: AgentSessionRow): TeamChatAgentSession {
  const runtimeConversation = parseRuntimeConversation(row.runtime_conversation);
  const lastContextMessageId = nullableString(row.last_context_message_id);
  return {
    roomId: String(row.room_id),
    agentId: String(row.agent_id),
    runtimeId: String(row.runtime_id),
    channelId: String(row.channel_id),
    modelId: String(row.model_id),
    runtimeConversation,
    ...(lastContextMessageId ? { lastContextMessageId } : {}),
    roomContextSequence: Number(row.room_context_sequence),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapWorkspaceReservationRow(row: WorkspaceReservationRow): TeamChatWorkspaceReservation {
  const reason = nullableString(row.reason);
  return {
    roomId: String(row.room_id),
    memberId: String(row.member_id),
    relativePath: String(row.relative_path),
    ...(reason ? { reason } : {}),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parseRuntimeConversation(value: unknown): TeamChatAgentSession["runtimeConversation"] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Stored Agent conversation is invalid.");
  const record = parsed as Record<string, unknown>;
  if (typeof record.runtimeId !== "string" || typeof record.codecVersion !== "string" || !("payload" in record)) {
    throw new Error("Stored Agent conversation is invalid.");
  }
  return {
    runtimeId: record.runtimeId as TeamChatAgentSession["runtimeConversation"]["runtimeId"],
    codecVersion: record.codecVersion,
    payload: structuredClone(record.payload),
  };
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined || value === "" ? undefined : Number(value);
}

function nullableDate(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toIsoString(value);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function postgresConnectionError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "28P01") return new Error("Unable to connect to PostgreSQL: authentication failed.", { cause: error });
  if (code === "3D000") return new Error("Unable to connect to PostgreSQL: database does not exist.", { cause: error });
  if (code === "ECONNREFUSED") return new Error("Unable to connect to PostgreSQL: connection was refused.", { cause: error });
  return new Error("Unable to connect to PostgreSQL.", { cause: error });
}
