"""
notifications.py - handle user event notifications

Writes to MongoDB Collection: notifications
"""
import copy
import os
import sys
from datetime import datetime

import simplejson as json
from bson.objectid import ObjectId


# To allow these files to be run directly from command line (w/o Django shell)

os.environ['DJANGO_SETTINGS_MODULE'] = "settings"
p = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, p)
sys.path.insert(0, p + "/sefaria")

from django.template.loader import render_to_string

from sefaria.system.database import db
from sefaria.users import user_name

class Notification(object):
	def __init__(self, uid=None, date=None, obj=None, _id=None):
		if uid:
			# create a new notification for uid
			self.uid     = uid
			self.date    = date or datetime.now()
			self.read    = False
			self.type    = "unset"
			self.content = {}
		elif obj:
			# load an existing notification from a dictionary
			self.__dict__.update(obj)
		elif _id:
			# look up notifications by _id from db
			if isinstance(_id, basestring):
				# allow _id as either string or ObjectId
				_id = ObjectId(_id)
			notification = db.notifications.find_one({"_id":_id})
			if notification:
				self.__init__(obj=notification)

	def make_sheet_like(self, liker_id=None, sheet_id=None):
		"""Make this Notification for a sheet like event"""
		self.type                = "sheet like"
		self.content["liker"]    = liker_id
		self.content["sheet_id"] = sheet_id
		return self

	def make_message(self, sender_id=None, message=None):
		"""Make this Notification for a user message event"""
		self.type               = "message"
		self.content["message"] = message
		self.content["sender"]  = sender_id
		return self

	def make_follow(self, follower_id=None):
		"""Make this Notification for a new Follow event"""
		self.type               = "follow"
		self.content["follower"]  = follower_id
		return self

	def mark_read(self, via="site"):
		self.read     = True
		self.read_via = via
		return self

	def save(self):
		db.notifications.save(vars(self))
		return self

	def to_JSON(self):
		notification = copy.deepcopy(vars(self))
		if "_id" in notification:
			notification["_id"] = self.id
		notification["date"] = notification["date"].isoformat()	
	
		return json.dumps(notification)

	def to_HTML(self):
		return render_to_string("elements/notification.html", {"notification": self})

	@property
	def id(self):
		return str(self._id)

	@property
	def actor_id(self):
		"""The id of the user who acted in this notification"""
		keys = {
			"message":    "sender",
			"sheet like": "liker",
		}
		return self.content[keys[self.type]]


class NotificationSet(object):
	def __init__(self):
		self.notifications = []

	def from_query(self, query, limit=0, page=0):
		self.notifications = []
		notifications = db.notifications.find(query).sort([["_id", -1]]).skip(page*limit).limit(limit)
		self.has_more = notifications.count() == limit 
		for notification in notifications:
			self.notifications.append(Notification(obj=notification))
		return self

	def unread_for_user(self, uid):
		self.from_query({"uid": uid, "read": False})
		return self

	def recent_for_user(self, uid, limit=10, page=0):
		self.from_query({"uid": uid}, limit=limit, page=page)
		return self

	def mark_read(self, via="site"):
		"""Marks all notifications in this set as read""" 
		for notification in self.notifications:
			notification.mark_read(via=via).save()

	@property
	def count(self):
		return len(self.notifications)

	@property
	def unread_count(self):
		return len([n for n in self.notifications if not n.read])

	def actors_list(self):
		"""Returns a unique list of user ids who acted in this notification set"""
		return list(set([n.actor_id for n in self.notifications]))

	def actors_string(self):
		"""
		Returns a nicely formatted string listing the people who acted in this notifcation set
		"""
		actors = [user_name(id) for id in self.actors_list()]
		top, more = actors[:3], actors[3:]
		if len(more) == 1:
			top[2] = ["2 others"]
		elif len(more) > 1:
			top.append("%d others" % len(more))
		if len(top) > 1:
			top[-1] = "and " + top[-1]
		return ", ".join(top).replace(", and ", " and ")

	def to_JSON(self):
		return "[%s]" % ", ".join([n.to_JSON() for n in self.notifications])

	def to_HTML(self):
		html = [n.to_HTML() for n in self.notifications]
		return "".join(html)




