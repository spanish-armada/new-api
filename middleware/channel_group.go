package middleware

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ChannelGroupScope limits a non-root administrator to the channels of their own
// group on every route that carries the channel id in its path, whatever the
// method: reading, editing, deleting, testing and key operations are gated the
// same way. Routes that take channel ids in the request body check them in their
// handlers, because gin cannot bind a body here without consuming it.
func ChannelGroupScope() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetInt("role") == common.RoleRootUser {
			c.Next()
			return
		}

		id, err := strconv.Atoi(c.Param("id"))
		if c.Param("id") == "" || err != nil {
			c.Next()
			return
		}

		channel, err := model.GetChannelById(id, false)
		if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && channel == nil) {
			apiErrorChannelNotFound(c)
			return
		}
		if err != nil {
			common.SysError(common.LogText("failed to load channel %d for group scope: %s", id, err.Error()))
			common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Failed to load the channel. Please try again later"))
			c.Abort()
			return
		}

		if !model.ChannelInGroup(channel, c.GetString("group")) {
			apiErrorChannelNotFound(c)
			return
		}

		c.Next()
	}
}

// apiErrorChannelNotFound answers the same way for a missing channel and for one
// outside the caller's group, so the response cannot be used to enumerate ids.
func apiErrorChannelNotFound(c *gin.Context) {
	common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Channel does not exist"))
	c.Abort()
}
